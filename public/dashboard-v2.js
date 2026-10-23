// Dashboard v2 (DASHBOARD_V2=on only): the tab strip the existing cards move into, the Today strip, the Rankings tiles,
// the City header, Founder Status and the Founder card. dashboard.js fetches this file only when /api/me says
// dashboardV2: true, then drives it through window.VDash: init(ctx) before the page shows, render(d) after every
// /api/me, coin() after every coin answer, mod() after /api/mod, coinQueue(n) after the admin queue, start() once.
// It never asks the server for anything and never builds markup from text: every element it fills is static in
// dashboard.html, and it creates no element with an id. The Wallet tab's balances come through dashboard.js too: wallet(r) after it read
// the two answers the site already has (the tab asks for them with ctx.readWallet(), and for the QR code library with ctx.qr()).
//
// Where every element of dashboard.html lives (one place each; test/dashboard-v2.test.js checks the built page against ORDER):
//   GLOBAL (never moved)  #dash-skel, #dash-out, #dash-onboard, #proof-modal, #locate-modal, #toast, #termsgate
//   RETIRED (hidden)      #dash-main .dash-tools (#layout-edit, #layout-reset), #dash-main .dash-grid (#col-main, #col-side, emptied)
//   home      -> #panel-home       #pf-notice, #ban-notice, #lost-alert, #welcome, #dash-top, #today, #trade, #wallet-card, #role-home, #portfolio, #badges
//                                  (#wallet-card stands right after #welcome while it asks for something, after #trade as a phone's buy card: placeCard;
//                                  in #panel-wallet while the Wallet tab is open with no wallet linked)
//   wallet    -> #panel-wallet     #wt-receive (the address, Copy, the QR code), #wt-balances (SOL, $VICINITY, the city coins held; Buy & swap)
//   city      -> #panel-city       #city-subnav, #community, #coin, #city-about, #request
//   community -> #panel-community  #feed, #national
//   notify    -> #panel-notify     #notices, #notice-prefs (in-app notices, NOTIFY=on: the tab shows when /api/me carries `unread`; dashboard.js fills them)
//   rankings  -> #panel-rankings   #rankings-card
//   founder   -> #panel-founder    #fcard, #lp-launch (the launch on the Vicinity launchpad, public/lp-launch.js), #progress, #squad,
//                                  #studio-card (gets #coin-studio out of #coin), #danger-zone, #founder-foot
//   moderate  -> #panel-moderate   #mod, #coin-admin-card (gets #coin-admin out of #coin)
//   profile   -> #panel-profile    #profile-modal (as an in-flow block), #roles-fold (gets #roles)
//   strip                          #dash-tabs (#dash-tablist, the #tab-* links, the glass pill .dtabs__ind and the #panel-* sections above)
//                                  (a phone, ICONS: every tab is its line icon, the chosen one's name under it, the pill behind the icon;
//                                  no Profile tab in the strip: the header's avatar opens it, inStrip / keyStop)
(() => {
  "use strict";
  const { $, $$, el, fmt, mask, copy } = window.V;
  const byId = (id) => document.getElementById(id);

  const TABS = Object.freeze(["home", "wallet", "city", "community", "notify", "rankings", "founder", "moderate", "profile"]);
  const LABEL = { home: "Home", wallet: "Wallet", city: "City", community: "Community", notify: "Notifications", rankings: "Rankings", founder: "Founder", moderate: "Moderate", profile: "Profile" };
  // the cards, in the order they stand in each panel (the static v2 blocks are listed too, so the order is one list)
  const ORDER = Object.freeze({
    home: ["#pf-notice", "#ban-notice", "#lost-alert", "#welcome", "#dash-top", "#today", "#trade", "#wallet-card", "#role-home", "#portfolio", "#badges"],
    wallet: ["#wt-receive", "#wt-balances"],
    city: ["#city-subnav", "#community", "#coin", "#city-about", "#request"],
    community: ["#feed", "#national"],
    notify: ["#notices", "#notice-prefs"],
    rankings: ["#rankings-card"],
    founder: ["#fcard", "#coin-ready", "#lp-launch", "#progress", "#squad", "#studio-card", "#danger-zone", "#founder-foot"],
    moderate: ["#mod", "#coin-admin-card"],
    profile: ["#profile-modal", "#roles-fold"],
  });
  // a link to a card by its old hash (#progress, #coin, ...) opens the card's tab, then scrolls to the card
  const ALIAS = { progress: "founder", squad: "founder", "coin-studio": "founder", "lp-launch": "founder", "coin-ready": "founder", coin: "city", "cc-top": "city", request: "city", "city-about": "city",
    feed: "community", national: "community", notices: "notify", "notice-prefs": "notify", mod: "moderate", roles: "profile", trade: "home", badges: "home", portfolio: "home", "role-home": "home", "wallet-card": "home", welcome: "home",
    "profile-account": "profile" }; // (the header's account sheet: Account is the Profile tab's Wallet and sign-in rows, Settings the notification settings)
  // a phone: the strip is icons (polish-dash.css, the same query): the glass pill sits behind the chosen tab's icon, the fit steps are not needed
  const ICONS = "(max-width: 600px)";
  const iconMode = () => Boolean(window.matchMedia && window.matchMedia(ICONS).matches);
  // Where a jump may put something: under the site header and, for a card in a tab, under the strip where it sticks. Read from the page,
  // never assumed: the header is 8 px down on a phone, or under a notched iPhone's status bar in a full-screen web view (style.css:
  // env(safe-area-inset-top), --header-h follows), 12 px down on a computer; its place in the page is where it sticks, so its bottom edge
  // is the same at any scroll. The strip sticks at its own top (polish-dash.css: 6 px under --header-h on a phone).
  const headerBottom = () => { const h = document.querySelector(".site-header"); return h ? h.getBoundingClientRect().bottom : 68; };
  const stripBottom = () => {
    const strip = byId("dash-tabs"), cs = typeof window.getComputedStyle === "function" ? window.getComputedStyle(strip) : null, top = cs ? parseFloat(cs.top) : NaN;
    return (Number.isFinite(top) ? top : headerBottom()) + strip.offsetHeight;
  };
  const QUEUE = [["posts", "reported post", "reported posts"], ["proposals", "ban proposal", "ban proposals"], ["appeals", "appeal", "appeals"],
    ["objections", "objection", "objections"], ["towns", "town request", "town requests"], ["coins", "coin contract to check", "coin contracts to check"]];
  // the coins' words while the old LaunchLab path is closed: nobody checks such a contract any more, it can only be rejected
  const QUEUE_COINS_CLOSED = ["old contract to settle", "old contracts to settle"];

  let ctx = null, active = "home", pending = null, lastMod = null, coin = null, coinKnown = false, coinQueueN = 0, fcardAction = null, lastTarget = null, targetTimer = 0;
  // the glass pill behind the chosen tab: its box now ({ x, y, w, h }, or null until it has measured a tab), its slide on the way, and
  // whether the first tab has been shown (the first panel rises in; later ones come from the side of the tab that was left)
  let pill = null, pillAnim = null, started = false;
  // the tabs gliding to new places after a change on screen (reflow: tab -> its animation), and whether such a change is running
  const tabGlides = new Map();
  let reflowing = false;
  // the launch on our own launchpad (public/lp-launch.js through dashboard.js): { on, state } once known (state null: its status is on
  // its way, or could not be asked)
  let lp = { on: false, state: null };
  // the old Raydium LaunchLab path as the server says it in the coin's own answer (GET /api/coins launchLabClosed, through dashboard.js
  // coin() and coinQueue()): true closed (the launchpad's settings are there), false open, null not said yet. The old path's words show
  // ONLY when the server said it is open (labOpen); not said yet, the card says nothing it would have to take back.
  let lab = null;
  const lpEra = () => lp.on || lab === true; // city coins launch on the Vicinity launchpad here
  const labOpen = () => !lpEra() && lab === false;
  // a contract sent through the old LaunchLab path before the launchpad was set up: with the launchpad set up nobody records it, an
  // admin can only reject it (src/coins.js), and nothing launches while it waits (src/lplaunch.js says the same words). What it means
  // comes first, so a line cut short on a phone still says it.
  const LEGACY_CONTRACT = "Nothing can launch until an admin settles the contract sent for this city through the old Raydium LaunchLab path.";
  // the launchpad's words while the launch card's status is on its way (or could not be asked): true whatever it will say
  const LP_PENDING = "Your coin launches on the Vicinity launchpad, after an admin approves it on chain.";
  const me = () => (ctx ? ctx.me() : null);
  const countryName = (cc) => (ctx ? ctx.countryName(cc) : cc);
  const behavior = () => (window.V.reduced ? "auto" : "smooth");
  const date = (iso) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  const when = (iso) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const left = (iso) => { const ms = Date.parse(iso) - Date.now(); if (ms <= 0) return "closing now"; const h = Math.floor(ms / 3600000); return h >= 48 ? `${Math.floor(h / 24)} days left` : h >= 1 ? `${h}h left` : `${Math.ceil(ms / 60000)} min left`; };
  const daysLeft = (iso) => Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 86400000));
  const pctText = (p) => (p >= 10 ? p.toFixed(1) : p >= 0.01 ? p.toFixed(2) : "<0.01");
  // the city coin's label: the server's ticker ("$UTICA": the chain's symbol once launched, else the city list's), or the city's
  // name when it has none. Nothing here makes a ticker up from the name.
  const coinLabel = (c) => (c.ticker ? `$${c.ticker}` : c.name);
  const modOn = () => { const m = me(); return Boolean((lastMod && lastMod.moderator === true) || (m && m.roles && m.roles.admin)); };
  // in-app notices (NOTIFY=on): /api/me carries `unread` (a number) only while the switch is on; the tab exists only then
  const notifyOn = () => { const m = me(); return Boolean(m && typeof m.unread === "number"); };
  // the ready-made city coin (COIN_V2_READY=on): /api/me carries coinV2Ready only while the switch is on; the coin is then chosen in #coin-ready
  const readyOn = () => { const m = me(); return Boolean(m && m.coinV2Ready === true); };
  // the last answer of GET /api/coins/ready (public/coin-ready.js tells it through dashboard.js; COIN_V2_READY=on): the founder's own
  // view ({ mode: "founder", coin, inUse, gate, ... }) or a preview; null until it is known
  let readyCoin = null, readyKnown = false;
  const readyFounder = () => (readyCoin && readyCoin.mode === "founder" ? readyCoin : null);
  // with the city-coin launch on (lp, public/lp-launch.js): the chain's word wins, so this fact agrees with the launch card's tag
  // (with the ready-made coin on, nobody designs a coin: the founder chooses it, then it is chosen and not launched yet; a city with
  // no founder has nobody to choose it)
  const unchosen = () => { const m = me(), s = m && m.community && m.community.seat; return !s ? "No founder yet" : s.you ? "Ready to choose" : "Not chosen yet"; };
  const coinState = () => (!coin ? (readyOn() ? unchosen() : "Not designed yet") : coin.launched || (lp.on && lp.state === "launched") ? "Live" : coin.waiting ? (lpEra() ? "Old contract waiting" : "Contract being checked")
    : lp.on && lp.state === "ready" ? "Approved" : readyOn() ? "Not launched yet" : "Designed");

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
    // the header's account sheet (site.js): Profile opens the tab (the keyboard on its panel), Account and Settings the card in theirs
    window.V.accountGo = (hash) => { if (TABS.includes(hash)) { go(hash); byId("panel-" + hash).focus({ preventScroll: true }); } else goTo("#" + hash); };
    try { history.scrollRestoration = "manual"; } catch {}
    $("#dash-main").addEventListener("click", onClick);
    $("#dash-tablist").addEventListener("keydown", onKey);
    $("#dash-tablist").addEventListener("scroll", edges, { passive: true });
    $("#fcard-go").addEventListener("click", () => { if (fcardAction) fcardAction(); });
    $("#wt-copy").addEventListener("click", copyAddress);
    $("#wt-refresh").addEventListener("click", () => { if (ctx && ctx.readWallet) ctx.readWallet(); });
    $("#trade").addEventListener("click", postProcess); // dashboard.js redraws the trade card on its own clicks
    window.addEventListener("hashchange", onHash);
    // the fit check runs when the width changes; a phone's address bar showing or hiding changes only the height (the strip is the
    // same, and a slide on its way is not restarted)
    let lastWidth = window.innerWidth;
    window.addEventListener("resize", () => { const w = window.innerWidth; if (typeof w === "number" && w === lastWidth) return; lastWidth = w; measure(); });
    // the pill follows its tab whenever a tab changes size (the strip shown, a badge, a fit step, Moderate shown or hidden, a font
    // that loads late): it only moves the pill, which nothing observes, so it never loops. The fonts change the words' widths, so
    // the fit check runs again once they are in.
    if (window.ResizeObserver) {
      const ro = new window.ResizeObserver(() => place());
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
  const dv2Top = () => $("#dv2").getBoundingClientRect().top + window.scrollY - headerBottom() - 8;
  function go(tab, { push = true, scroll = true, replace = false } = {}) {
    if (!TABS.includes(tab)) tab = "home";
    if (tab === "moderate" && !modOn()) { pending = "moderate"; tab = "home"; push = false; replace = true; } // opens once /api/mod says so
    else if (push) pending = null; // the person chose another tab meanwhile: a late /api/mod answer must not pull them away from it
    if (tab === "wallet" && !walletOn()) { tab = "home"; push = false; replace = true; } // the tab is hidden (gate): nothing to show there
    if (tab === "notify" && !notifyOn()) { tab = "home"; push = false; replace = true; } // a #notify link with the switch off: Home
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
    if (ctx && was !== tab && (was === "wallet" || tab === "wallet")) placeCard(); // the wallet card stands in the Wallet tab while it is open with no wallet linked
    if (tab === "wallet") enterWallet();
    if (tab === "notify" && ctx && ctx.openNotices) ctx.openNotices(); // dashboard.js loads the list (and marks what it shows read after 2 s)
    measure(started && was !== tab ? "slide" : ""); // a new tab the person chose: the pill slides there (the first one is simply set)
  }
  /** Only when the strip scrolls (200% text): bring the tab into view by the least distance ("nearest"), so Home is never pushed out. */
  function centerTab(tab) {
    const list = $("#dash-tablist"), t = byId("tab-" + tab);
    if (!list || !t || !inStrip(t) || list.scrollWidth <= list.clientWidth + 1) return;
    const lr = list.getBoundingClientRect(), tr = t.getBoundingClientRect(), pad = 28;
    const dx = tr.left < lr.left + pad ? tr.left - lr.left - pad : tr.right > lr.right - pad ? tr.right - lr.right + pad : 0;
    if (dx) list.scrollTo({ left: list.scrollLeft + dx, behavior: behavior() });
  }
  /**
   * The strip fits the screen: every tab whole and shown, no sideways strip. Should seven tabs not fit (a moderator on a phone), one step
   * at a time: the gaps close (.is-snug), "Rankings" says "Rank" (.is-short), Founder and Moderate show as their icons (.is-compact). The
   * tabs never shrink below their words, so a tight strip is seen as one. Only if it still does not fit (a large text setting) does the
   * strip scroll (.is-scrollable, with edge fades). A phone's icons (ICONS) have two steps: the row drops its inner padding and, below
   * 375 px, the strip widens to 4 px from the screen's edges (.is-flush: only when needed, so the strip otherwise lines up with the
   * header), then it scrolls. Then the glass pill goes to the chosen tab (place): `how` is "slide" for a tab the
   * person chose, "follow" while the tabs glide to new places (reflow), else it is set at once, or a slide on its way turns there in
   * the time it had left. While the tabs are measured the pill is parked at no size, so where it was a moment ago (a wider strip)
   * never counts as overflow.
   */
  function measure(how) {
    const list = $("#dash-tablist"), strip = $("#dash-tabs");
    if (!list || !strip) return;
    // (a phone's icons: any whole pixel over counts, so a moderator's 8 tabs at 375 px, 1 px too wide as they are, go flush and fit;
    // the words' strip keeps a pixel of slack for its sub-pixel word widths)
    const icons = iconMode(), over = () => list.scrollWidth > list.clientWidth + (icons ? 0 : 1);
    const left = park();
    const steps = ["is-snug", "is-short", "is-compact", "is-scrollable"];
    strip.classList.remove(...steps, "is-flush");
    for (const step of icons ? ["is-flush", "is-scrollable"] : steps) { if (!over()) break; strip.classList.add(step); } // icons: tighter, then they scroll (with snap)
    edges();
    keyStop();
    place(how || (reflowing ? "follow" : ""), left);
  }
  /** A row that scrolls: a fade on each side that has more (.is-scrolled: some tabs are off to the left; .is-end: none to the right). */
  function edges() {
    const list = $("#dash-tablist"), strip = $("#dash-tabs");
    if (!list || !strip) return;
    strip.classList.toggle("is-scrolled", list.scrollLeft > 4);
    strip.classList.toggle("is-end", list.scrollLeft >= list.scrollWidth - list.clientWidth - 4);
  }
  /**
   * A phone: Profile has no tab in the strip (polish-dash.css D2c; owner, 17 Oct 2026: "remove one", "keep a single avatar in the
   * top-right that opens Profile, Account and Settings"): the header's avatar opens it. While it is the chosen tab, the avatar wears the
   * chosen ring (polish.css .hdr-avatar.is-current) and the sheet's Profile row says it is the current place, and the strip's one Tab
   * stop is Home (the chosen tab is not there to take it), so the keyboard still reaches the strip. A computer: every tab is in it.
   */
  function inStrip(t) { return Boolean(t) && !t.hidden && !(t.dataset.tab === "profile" && iconMode()); }
  function keyStop() {
    const tabs = $$(".dtab", $("#dash-tablist")), chosen = byId("tab-" + active), stop = inStrip(chosen) ? chosen : byId("tab-home");
    for (const t of tabs) t.setAttribute("tabindex", t === stop ? "0" : "-1");
    const onProfile = active === "profile", av = $("[data-account-avatar]"), row = $('[data-acct-go="profile"]');
    if (av) av.classList.toggle("is-current", onProfile && iconMode());
    if (row) { if (onProfile) row.setAttribute("aria-current", "true"); else row.removeAttribute("aria-current"); }
  }

  /* ---------- the glass pill: one marker behind the chosen tab that slides (and stretches a little) to the next one ---------- */
  // .dtabs__ind is static in dashboard.html, hidden from screen readers and the pointer (polish-dash.css), and sits inside the list,
  // so it scrolls with the tabs on a phone. Its box is the chosen tab's, to the sub-pixel, in the list's scrolled coordinates. It
  // slides with the Web Animations API (the CSP allows script-set styles) and is set at once with reduced motion or "Pause
  // animations". Tabs of one width (a computer: every tab one equal part) slide on transform alone (translate and scaleX from the
  // left edge), which the compositor runs; tabs of different widths (a phone, a tablet) also change the width, because a scaled
  // capsule would squash its round ends. Until it has measured a tab (the strip not laid out yet) the chosen tab keeps its own look.
  const PILL_MS = 320, FOLLOW_MS = 240, PILL_EASE = "cubic-bezier(.2,.8,.2,1)";
  // a slide to a new tab, in two halves (the effect itself is linear): it speeds up to its middle, where it is stretched the most, then
  // settles on the new tab. The halves meet at the same speed (twice the average), so the motion has no kink; the middle comes at
  // 45% of the time with the centre 55% of the way. The stretch: a quarter of the distance, at most 48 px and half the wider tab.
  const PILL_IN = "cubic-bezier(.4,0,.7,.51)", PILL_OUT = "cubic-bezier(.2,.49,.3,1)", PILL_MID = 0.45, PILL_AHEAD = 0.55;
  const r2 = (n) => Math.round(n * 100) / 100;
  /** Where the pill goes: the tab's rectangle in the list's content coordinates (rectangles from getBoundingClientRect). Pure. */
  function pillBox(tab, list, scrollLeft = 0, scrollTop = 0) {
    return { x: r2(tab.left - list.left + scrollLeft), y: r2(tab.top - list.top + scrollTop), w: r2(tab.width), h: r2(tab.height) };
  }
  const near = (a, b) => Boolean(a && b) && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.w - b.w) < 0.5 && Math.abs(a.h - b.h) < 0.5;
  /** The pill's own style for a box (set once per place; the height never animates). */
  const pillStyle = (b) => ({ transform: `translate(${b.x}px, ${b.y}px)`, width: `${b.w}px`, height: `${b.h}px` });
  /**
   * The keyframes from one box to another (element.animate with a linear effect: each keyframe carries its easing). `stretch`: a new
   * tab, the leading edge runs ahead and the pill is longest in the middle; otherwise one smooth move. `base`: the pill's width during
   * the move when only transform changes (from and to the same width), else null and the width moves too. Pure.
   */
  function pillFrames(from, to, stretch = true) {
    const base = Math.abs(from.w - to.w) < 0.5 ? to.w : null;
    const frame = (b) => (base ? { transform: `translate(${b.x}px, ${b.y}px) scaleX(${Math.round((b.w / base) * 1e4) / 1e4})` } : { transform: `translate(${b.x}px, ${b.y}px)`, width: `${b.w}px` });
    const c0 = from.x + from.w / 2, c1 = to.x + to.w / 2, d = Math.abs(c1 - c0);
    if (!stretch || d < 1) return [{ ...frame(from), easing: PILL_EASE }, frame(to)];
    const wide = Math.max(from.w, to.w), w = wide + Math.min(d / 4, 48, wide / 2), c = c0 + (c1 - c0) * PILL_AHEAD;
    const mid = { x: r2(c - w / 2), y: r2(from.y + (to.y - from.y) / 2), w: r2(w) };
    return [{ ...frame(from), easing: PILL_IN }, { ...frame(mid), offset: PILL_MID, easing: PILL_OUT }, frame(to)];
  }
  /** The pill's box from its computed style (mid-slide: where the animation has it now; a matrix's scaleX times the width), or null. Pure. */
  function pillFromStyle(transform, width, height) {
    const m = /^matrix\(([^)]+)\)$/.exec(String(transform || "").trim());
    const p = m ? m[1].split(",").map(Number) : null;
    const w = parseFloat(width), h = parseFloat(height);
    return p && p.length === 6 && p.every(Number.isFinite) && Number.isFinite(w) && Number.isFinite(h) ? { x: r2(p[4]), y: r2(p[5]), w: r2(w * p[0]), h: r2(h) } : null;
  }
  const pillEl = () => $("#dash-tablist .dtabs__ind");
  let pillMs = 0; // the length of the slide on its way
  /** Stops the slide on its way, remembering where the pill is right now. Returns the time it still had (ms). */
  function stop() {
    const ind = pillEl(), a = pillAnim, cs = window.getComputedStyle(ind), t = Number(a.currentTime);
    pill = pillFromStyle(cs.transform, cs.width, cs.height) || pill;
    a.cancel(); pillAnim = null;
    return Number.isFinite(t) ? Math.max(0, pillMs - t) : pillMs;
  }
  /** Stops a slide on its way and parks the pill at no size. Returns the time that slide still had (0: none). */
  function park() {
    const ind = pillEl();
    if (!ind) return 0;
    const left = pillAnim ? stop() : 0;
    ind.style.width = "0px"; ind.style.transform = "none";
    return left;
  }
  /** A tab's box where the layout has it (a tab gliding to a new place, reflow, is measured without its glide): on a phone, its icon's. */
  function boxOf(tab) {
    const mark = iconMode() ? tab.querySelector(".dtab__ico") || tab : tab;
    const r = mark.getBoundingClientRect();
    if (!tabGlides.has(tab)) return r;
    const m = /^matrix\(([^)]+)\)$/.exec(String(window.getComputedStyle(tab).transform || "").trim()), dx = m ? Number(m[1].split(",")[4]) || 0 : 0;
    return { left: r.left - dx, top: r.top, width: r.width, height: r.height };
  }
  /** Puts the pill behind the chosen tab. `how`: "slide" (a new tab: the full slide), "follow" (its tab glides to a new place: the
   *  same glide), "" (at once; a slide on its way turns there in `left` ms, the time it had left, at least 120). */
  function place(how = "", left = 0) {
    const list = $("#dash-tablist"), strip = $("#dash-tabs"), ind = pillEl(), tab = byId("tab-" + active);
    if (!list || !strip || !ind) return;
    const tr = inStrip(tab) ? boxOf(tab) : null, lr = list.getBoundingClientRect();
    if (!tr || !tr.width || !lr.width) { // not laid out (a hidden strip), or the chosen tab is not in the strip (a phone's Profile): no pill
      if (pillAnim) { pillAnim.cancel(); pillAnim = null; }
      pill = null; strip.classList.remove("has-ind");
      return;
    }
    const to = pillBox(tr, lr, list.scrollLeft, list.scrollTop);
    if (pillAnim) {
      if (near(pill, to)) return; // already on its way there (a ResizeObserver answer mid-slide)
      left = Math.max(left, stop()); // on its way elsewhere: it turns from where it is now
    }
    const from = pill;
    Object.assign(ind.style, pillStyle(to));
    pill = to;
    strip.classList.add("has-ind");
    const ms = how === "slide" ? PILL_MS : how === "follow" ? FOLLOW_MS : left > 0 ? Math.max(left, 120) : 0;
    if (ms && from && !near(from, to) && !window.V.reduced && typeof ind.animate === "function") {
      const anim = ind.animate(pillFrames(from, to, how === "slide"), { duration: ms });
      pillAnim = anim; pillMs = ms;
      anim.onfinish = () => { if (pillAnim === anim) pillAnim = null; };
    }
  }
  /**
   * Something changes the tabs while the strip is on screen (Moderate shown or hidden when /api/mod answers, a count badge): every
   * tab glides from where it was to its new place (transform only, FOLLOW_MS), the pill glides with its tab, and a tab that just
   * appeared fades in, so the bar re-divides as one calm move instead of a jump. At once with reduced motion (V.reduced),
   * and before the strip has been shown. Nested calls run inside the outer one.
   */
  function reflow(fn) {
    const list = $("#dash-tablist");
    if (reflowing || !started || !pill || !list || window.V.reduced) { fn(); return; }
    const tabs = $$(".dtab", list), before = new Map();
    for (const t of tabs) if (!t.hidden) before.set(t, t.getBoundingClientRect().left); // where each one is on screen now
    for (const a of tabGlides.values()) a.cancel();
    tabGlides.clear();
    reflowing = true;
    try { fn(); } finally { reflowing = false; }
    if (typeof list.animate !== "function") return;
    for (const t of tabs) {
      if (t.hidden) continue;
      if (!before.has(t)) { t.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FOLLOW_MS, easing: PILL_EASE }); continue; }
      const dx = r2(before.get(t) - t.getBoundingClientRect().left);
      if (Math.abs(dx) < 0.5) continue;
      const a = t.animate([{ transform: `translateX(${dx}px)` }, { transform: "none" }], { duration: FOLLOW_MS, easing: PILL_EASE });
      tabGlides.set(t, a);
      a.onfinish = () => { if (tabGlides.get(t) === a) tabGlides.delete(t); };
    }
  }
  /** Open the tab a card is in and scroll to the card (opening any <details> around it). */
  function goTo(selector, { focus = true, openRole, noAlias = false } = {}) {
    let sel = selector;
    if (sel === "#notice-prefs" && !notifyOn()) { go("profile", { push: started, replace: !started }); return; } // the account sheet's Settings with notices off: the Profile tab
    if (!noAlias && sel === "#coin" && !$("#studio-card").hidden) sel = "#coin-studio"; // the founder lands on the studio, everyone else on the coin
    if (sel === "#trade" && $("#trade").hidden && !$("#wallet-card").hidden) sel = "#wallet-card"; // a phone's Safari buys in the wallet app
    const target = $(sel);
    if (!target) return;
    const panel = target.closest(".dpanel");
    if (!panel) { window.scrollTo({ top: target.getBoundingClientRect().top + window.scrollY - headerBottom() - 12, behavior: behavior() }); return; }
    const tab = panel.id.slice("panel-".length);
    go(tab, { push: tab !== active, scroll: false });
    if (active !== tab) return; // the tab is gated (Moderate without rights): it opens when the rights arrive
    for (let d = target.closest("details"); d; d = d.parentElement ? d.parentElement.closest("details") : null) d.open = true;
    if (openRole) { const r = $("#roles").querySelector(`details[data-role="${openRole}"]`); if (r) r.open = true; }
    if (target.closest("[hidden]")) return; // a card that is not shown right now (no squad, no studio): the tab is enough
    const top = target.getBoundingClientRect().top + window.scrollY - (stripBottom() + 12);
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
    const tabs = $$(".dtab", $("#dash-tablist")).filter((t) => inStrip(t) && t.getClientRects().length); // (a tab not in the strip is skipped: a phone's Profile)
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
  /**
   * The Wallet tab shows for a linked wallet, and with none for the new sign-up's wallet card (its connect and link paths). With the old sign-up
   * (SIGNUP_FLOW not v2) and no wallet, dashboard.js hides that card (its /connect cannot link one), so the tab would be empty: it is hidden too.
   */
  function walletOn() { const m = me(); return !m || Boolean(m.user && m.user.wallet) || m.signupFlow === "v2"; }
  function gate() {
    const on = modOn(), wOn = walletOn();
    $("#tab-moderate").hidden = !on;
    if (!on) $("#panel-moderate").hidden = true;
    $("#tab-wallet").hidden = !wOn;
    if (!wOn) $("#panel-wallet").hidden = true;
    if (on && pending === "moderate") { pending = null; go("moderate", { push: false, replace: true }); }
    else if ((!on && active === "moderate") || (!wOn && active === "wallet")) go("home", { push: false, replace: true });
    measure();
  }
  function queueCounts() {
    const m = lastMod && lastMod.moderator === true ? lastMod : null;
    const n = (k) => (m && Array.isArray(m[k]) ? (k === "proposals" ? m[k].filter((x) => x.canApprove).length : m[k].length) : 0);
    const counts = { posts: n("posts"), proposals: n("proposals"), appeals: n("appeals"), objections: n("objections"), towns: n("towns"), coins: coinQueueN };
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const parts = QUEUE.map((q) => (q[0] === "coins" && lpEra() ? ["coins", ...QUEUE_COINS_CLOSED] : q)).filter(([k]) => counts[k]).map(([k, one, many]) => `${counts[k]} ${counts[k] === 1 ? one : many}`);
    return { counts, total, parts };
  }
  function badge() {
    const { total } = queueCounts(), b = $("#tab-moderate-n");
    b.textContent = total ? String(total) : ""; b.hidden = !total;
    $("#tab-moderate").setAttribute("aria-label", total ? `Moderate, ${total} to review` : "Moderate"); // the count stays in the tab's name
    measure();
  }

  /* ---------- the Notifications tab (NOTIFY=on): shown only while /api/me carries `unread`; the count on the tab (0 hidden) and in its name ---------- */
  function notifyGate() {
    const on = notifyOn();
    $("#tab-notify").hidden = !on;
    if (!on) { $("#panel-notify").hidden = true; if (active === "notify") go("home", { push: false, replace: true }); }
  }
  function unreadBadge(n) {
    const k = Math.max(0, Math.floor(Number(n) || 0)), b = $("#tab-notify-n");
    b.textContent = k ? String(k) : ""; b.hidden = !k;
    $("#tab-notify").setAttribute("aria-label", k ? `Notifications, ${k} unread` : "Notifications"); // the count stays in the tab's name
    measure();
  }

  /* ---------- Today: up to four next steps, every one from a field /api/me, /api/mod or /api/coins already sends ---------- */
  function opensIn() {
    const at = window.V.opensAt ? window.V.opensAt() : 0, ms = at - Date.now();
    if (ms <= 0) return "";
    const dd = Math.floor(ms / 86400000), hh = Math.floor((ms % 86400000) / 3600000), mm = Math.floor((ms % 3600000) / 60000);
    return dd > 0 ? `${dd}d ${hh}h` : `${hh}h ${mm}m`;
  }
  /**
   * The Today line that sends the founder to "Use this coin": its title and its words, from the server's own flags (src/coinready.js
   * founderView), the way public/coin-ready.js words its note: a choice made by a former founder, the founder's own choice that the city
   * list or Vicinity's design has moved past (a new version), their choice whose design row changed since, an earlier studio design kept
   * aside (earlier), or no design at all. Never "your earlier design" for a design that was Vicinity's or a former founder's.
   */
  function readyStep(rf, city) {
    const ch = rf.chosen && !rf.chosen.launched ? rf.chosen : null;
    if (ch && ch.current && !ch.mine) return [`Choose ${city}'s coin`, "A former founder chose this coin. Use it to make it yours."];
    if (ch && ch.current) return [`Choose ${city}'s coin again`, "Vicinity's design or the city list changed since you chose. Check the new version, then use it."];
    if (ch && ch.mine) return [`Choose ${city}'s coin again`, "Your coin's design was changed since you chose it. Check it, then use it again."];
    if (rf.earlier) return [`Choose ${city}'s coin`, "Your earlier design is kept, but city coins are made by Vicinity now. Check yours, then use it."];
    return [`${city}'s coin is ready`, "The Vicinity design with your city's ticker, from the city list. Check it, then use it."];
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
    // the ready-made coin (COIN_V2_READY): said only once the founder's coin answer has a coin (a city the list has no ticker for gets none)
    const rf = readyFounder(), rcoin = Boolean(rf && rf.coin);
    if (readyOn()) { if (seated && coinKnown && rcoin && !rf.inUse && !rf.gate && (!coin || (!coin.launched && !coin.waiting))) add(...readyStep(rf, seat.city), "ok", "founder", "#coin-ready"); }
    else if (seated && coinKnown && !coin) add(`Design ${seat.city}'s coin`, "Name, pitch, pair, colour, logo (shown once checked). Public and logged.", "ok", "founder", "#coin-studio");
    // the old path's step only while the server says that path is open (never from a guess: a status call still on its way, a probe that failed)
    if (seated && coin && !coin.mint && !coin.waiting && labOpen() && !readyOn()) add("Add your coin's contract", "Launched it on Raydium LaunchLab? Send the address for a check.", "ok", "founder", "#cs-mint");
    if (seated && lp.on && lp.state === "ready") add("Launch your city coin", "An admin approved it. One signature in your wallet.", "ok", "founder", "#lp-launch");
    // with the Vicinity launchpad set up, a contract sent through the old LaunchLab path is never recorded, only rejected (src/coins.js)
    if (seated && coin && coin.waiting && lpEra()) add("Old contract waiting", LEGACY_CONTRACT, "info", "city", "#coin", true);
    else if (seated && coin && coin.waiting && labOpen()) add("Contract being checked", "An admin checks it on the blockchain. Nothing to do.", "info", "city", "#coin", true);
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
    // the Wallet tab with no wallet linked shows this very card (one card, one set of ids, the same connect and link paths): it stands in
    // that panel while the tab is open and comes back to Home with the next placing (go)
    const inWallet = active === "wallet" && !(m && m.user && m.user.wallet);
    if (inWallet) $("#panel-wallet").prepend(card);
    const merged = !inWallet && top && !welcome.hidden && !card.hidden; // the welcome and the wallet card read as one card
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
    const tk = coinLabel(c), s = c.seat, st = $("#ch-status");
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
    if (coinKnown) $("#ch-coin-v").textContent = `${tk} · ${coinState()}`;
    $("#ca-city").textContent = c.name;
    $("#ca-ticker").textContent = tk;
    const note = $("#ca-ticker-note"); if (note) { note.hidden = !c.ticker; note.textContent = c.tickerSource === "chain" ? "on chain" : "fixed by the map"; } // where the ticker comes from; nothing for a city without one
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
    // the ready-made coin (COIN_V2_READY): until the founder has chosen it ("Use this coin"), the card sends them to it, BEFORE the
    // launch's words (an approval of an earlier studio design aside: that one launches as approved)
    else if (readyOn() && readyFirst()) {
      const rf = readyFounder();
      if (!rf && !readyKnown) { note.textContent = "Checking your city coin…"; go.hidden = true; fcardAction = null; }
      else if (!rf) { note.textContent = "City coins are made by Vicinity from the city list now: yours is in your Founder tab."; button("See your city coin", "btn btn--glass", () => goTo("#coin-ready")); }
      else if (!rf.coin) { note.textContent = rf.gate ? rf.gate.message : ""; button("See your city coin", "btn btn--glass", () => goTo("#coin-ready")); }
      // something stands in the way of "Use this coin" (an approval for another wallet or of an earlier design, a low balance...): why
      else if (rf.gate) { note.textContent = rf.gate.message; button("See your city coin", "btn btn--glass", () => goTo("#coin-ready")); }
      else if (!coin) { note.textContent = `${seat.city}'s coin is ready: the Vicinity design with its ticker, from the city list. Check it, then use it.`; button("See your city coin", "btn btn--primary", () => goTo("#coin-ready")); }
      else { note.textContent = "Choose your city coin above (Use this coin); then Vicinity's owner approves it on the blockchain."; button("See your city coin", "btn btn--primary", () => goTo("#coin-ready")); }
    }
    else if (!coin) { note.textContent = `Your coin, your call. Design ${seat.city}'s coin: everyone in ${seat.city} sees it.`; button("Design the city coin", "btn btn--primary", () => goTo("#coin-studio")); }
    else if (coin.launched) { note.textContent = `${seat.city}'s coin is live. Its design is locked for good, as the rules promise.`; button("Manage city coin", "btn btn--primary", () => goTo("#coin", { noAlias: true })); }
    else if (!lpEra() && !labOpen()) { note.textContent = ""; go.hidden = true; fcardAction = null; } // which path is not said yet: nothing to take back
    else if (coin.waiting) { note.textContent = lpEra() ? LEGACY_CONTRACT : "An admin is checking the contract. Once recorded, the design is locked and it becomes the one official coin."; button("See the coin", "btn btn--glass", () => goTo("#coin", { noAlias: true })); }
    else if (lpEra()) {
      // the launch card's word (lp.state); none yet (its status on its way, or the launch card could not be shown): LP_PENDING, no button;
      // a status that could not be read ("error": the card says why): LP_PENDING too, never "not approved" from a guess
      const s = lp.on ? lp.state : null;
      note.textContent = s === "ready" ? "An admin approved your coin. Launch it on the Vicinity launchpad: one signature in your wallet."
        : s === "launched" ? "Your coin is live on the Vicinity launchpad."
          : s === "expired" ? "Your approval expired. Ask an admin to approve your coin again."
            : s === "paused" ? "Launches are paused for now. Your approval stays."
              : s === "not_approved" ? "An admin approves your coin on chain first; your pair must be SOL. Then you launch it here." : LP_PENDING;
      if (s) button(s === "ready" ? "Launch your city coin" : s === "launched" ? "See your coin" : "See the launch", s === "ready" ? "btn btn--primary" : "btn btn--glass", () => goTo("#lp-launch"));
      else { go.hidden = true; fcardAction = null; }
    }
    else if (readyOn()) { note.textContent = "Your coin is made by Vicinity from the city list. Check the coin you chose; Vicinity's owner approves it on the blockchain before it can launch."; button("See your city coin", "btn btn--primary", () => goTo("#coin-ready")); }
    else { note.textContent = "Launch it on Raydium LaunchLab, then add the contract here. An admin (never you) checks and records it."; button("Add the contract", "btn btn--primary", () => goTo("#cs-mint")); }
    $("#fcard-alt").hidden = !((st === "active" || st === "steward") && modOn());
    $("#fcard-meter").hidden = st !== "steward";
  }

  /**
   * COIN_V2_READY: the Founder card points at the ready-made coin first: no design yet, or a design that is not the chosen ready-made
   * coin (an earlier studio design, or a choice made stale) while nothing is approved or launched with it.
   */
  function readyFirst() {
    if (!coin) return true;
    if (coin.launched || coin.waiting || (lp.on && (lp.state === "ready" || lp.state === "launched"))) return false;
    const rf = readyFounder();
    return !rf || !rf.inUse;
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

  /* ---------- the Wallet tab: Receive (the address, a QR code of it) and the balances the site supports ---------- */
  // dashboard.js reads GET /api/me/portfolio ($VICINITY and the city coins held, with prices and where each ticker came from) and
  // GET /api/swap/balances (SOL and the token amounts, the Worker's 10-second memo) when the tab is entered or Refresh is tapped, at most
  // once per 10 s (the minute /api/me refresh does not read them again), then calls wallet(r): r = { owner, loading: true } on the way, else
  // { owner, balances, portfolio, portfolioOk, portfolioOff, solUsd, at } with balances or portfolio null when that answer failed (portfolioOk:
  // the city coins were read; portfolioOff: that route is off, PROFILES off) and at null when the Worker did not say when it read the chain.
  // Nothing is sent from here; sending is not part of this step.
  let walletData = null; // the last answer for the linked wallet (or null: not read yet)
  let qrFor = null; // the address the QR code on screen was drawn for
  let copyTimer = 0, restTimer = 0, resting = false; // Refresh rests REST_MS after a read: sooner would get the same memo
  const REST_MS = 10000;
  /** A coin amount by size: thousands with 2 decimals, units up to 4, fractions 6 significant digits; "—" when unknown. Pure. */
  function amountText(v) {
    const n = Number(v);
    if (v == null || !Number.isFinite(n)) return "—";
    const a = Math.abs(n);
    return a === 0 ? "0" : a >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : a >= 1 ? n.toLocaleString("en-US", { maximumFractionDigits: 4 }) : n.toLocaleString("en-US", { maximumSignificantDigits: 6 });
  }
  /** A US-dollar value: "$1,234.56" and "$0.50" (two decimals from one cent up); under a cent three significant digits ("$0.00123"); "—" when not known. Pure. */
  function usdText(v) {
    const n = Number(v);
    if (v == null || !Number.isFinite(n)) return "—";
    return n >= 0.01 || n === 0 ? "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "$" + n.toLocaleString("en-US", { maximumSignificantDigits: 3 });
  }
  const clock = (iso) => { const t = new Date(iso); return iso && Number.isFinite(t.getTime()) ? t.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : null; }; // null: no time to show
  /**
   * The rows of the balances list from the two answers. Pure. SOL first, then $VICINITY (its mint from /api/coins, else the portfolio's own
   * $VICINITY item: a wallet holding it is never shown empty because that call failed), then every city coin the
   * wallet holds (the portfolio's items of kind city) and the home city's launched coin when it holds none of it. amount: the balances
   * answer's for a mint it was asked about, else the portfolio's, else null; usd: the portfolio's price times that amount (SOL: solUsd), null
   * when not known. A city coin's label is its ticker from the chain or the city list ($UTICA, and where it came from); a coin with neither
   * goes by its name. Nothing here makes a ticker up.
   *   { key, label, sub, amount: number | null, usd: number | null }
   */
  function walletRows({ balances, portfolio, solUsd }, { vicMint, coin, community }) {
    const tokens = (balances && balances.tokens) || {};
    const asked = (m) => Boolean(m) && Object.prototype.hasOwnProperty.call(tokens, m) && tokens[m] && tokens[m].ui != null;
    const items = portfolio && Array.isArray(portfolio.items) ? portfolio.items : [];
    const item = (m) => items.find((i) => i && i.mint === m) || null;
    const amountOf = (m) => (asked(m) ? Number(tokens[m].ui) || 0 : item(m) ? Number(item(m).amount) || 0 : null);
    const usdOf = (m, a) => { const it = item(m); return it && it.priceUsd != null && a != null ? a * Number(it.priceUsd) : null; };
    const sol = balances && balances.sol && balances.sol.ui != null ? Number(balances.sol.ui) || 0 : null;
    const rows = [{ key: "SOL", label: "SOL", sub: "Solana", amount: sol, usd: sol != null && solUsd != null ? sol * Number(solUsd) : null }];
    const vic = vicMint || ((items.find((i) => i && i.kind === "vicinity") || {}).mint || null); // /api/coins' live mint, else the portfolio's
    if (vic) { const a = amountOf(vic); rows.push({ key: vic, label: "$VICINITY", sub: "Vicinity", amount: a, usd: usdOf(vic, a) }); }
    const cityRow = (mint, ticker, source, name, cityName) => {
      const a = amountOf(mint), where = source === "chain" ? " · ticker on chain" : source === "registry" ? " · ticker fixed by the map" : "";
      rows.push({ key: mint, label: ticker ? `$${String(ticker).replace(/^\$/, "")}` : name, sub: `${cityName} city coin${where}`, amount: a, usd: usdOf(mint, a) });
    };
    for (const it of items) if (it && it.kind === "city" && it.mint && it.mint !== vic) cityRow(it.mint, it.tickerSource ? it.symbol : null, it.tickerSource || null, it.name || it.symbol || "city coin", it.city && it.city.name ? it.city.name : it.name || "Your city");
    // the home city's launched coin, when the portfolio does not list it (it lists only what is held): its ticker is /api/me's
    const home = coin && coin.launched && coin.mint && coin.mint !== vic && !item(coin.mint) && community ? coin : null;
    if (home) cityRow(home.mint, community.ticker || null, community.ticker ? community.tickerSource || null : null, home.name || community.name, community.name);
    return rows;
  }
  /** The QR code of `text` as one SVG path (every dark module one square), or null without the library. */
  function qrPath(text) {
    if (typeof window.qrcode !== "function") return null;
    try {
      const q = window.qrcode(0, "M"); q.addData(text); q.make();
      const n = q.getModuleCount(); let d = "";
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
      return { d, size: n };
    } catch { return null; }
  }
  /** Draws the address's QR code into the static svg (dark modules, a quiet zone of two around them); without the library the figure stays hidden. */
  function drawQR(text) {
    const fig = $("#wt-qr"), q = qrPath(text);
    if (!q) { fig.hidden = true; qrFor = null; return; }
    $("#wt-qr svg").setAttribute("viewBox", `-2 -2 ${q.size + 4} ${q.size + 4}`);
    $("#wt-qr-path").setAttribute("d", q.d);
    fig.hidden = false; qrFor = text;
  }
  /**
   * The Wallet tab is open with a wallet linked: the QR code is drawn when the one on screen is not this address's (the library comes through
   * dashboard.js), and the balances are read: on entering the tab always (dashboard.js keeps that to one read per 10 s); after an /api/me
   * (again: false) only while nothing was read for this wallet yet, so the minute refresh never polls the chain. Refresh reads on its own.
   */
  function enterWallet({ again = true } = {}) {
    const m = me(), w = m && m.user && m.user.wallet;
    if (!w || !ctx) return;
    if (qrFor !== w && ctx.qr) ctx.qr().then((ok) => { const cur = me(); if (ok && cur && cur.user && cur.user.wallet === w) drawQR(w); });
    if ((again || !walletData) && ctx.readWallet) ctx.readWallet();
  }
  /** Copy: the address onto the clipboard; the button says "Copied" and the live region reads it out once (no toast: a second announcement). */
  async function copyAddress() {
    const m = me(), w = m && m.user && m.user.wallet;
    if (!w) return;
    let ok = false;
    try { await navigator.clipboard.writeText(w); ok = true; } catch { ok = false; }
    if (!ok) { if (typeof copy === "function") copy(w, "Address copied"); return; } // site.js: the address in a toast, to select by hand
    const b = $("#wt-copy"), live = $("#wt-copy-live");
    b.textContent = "Copied"; live.textContent = "Address copied";
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { b.textContent = "Copy"; live.textContent = ""; }, 2000);
  }
  function rowEl(r) {
    const li = el("li", "wtab-row");
    const name = el("span", "wtab-row__name"); name.append(el("strong", null, r.label), el("span", "wtab-row__sub", r.sub));
    const amt = el("span", "wtab-row__amt"); amt.append(el("strong", null, amountText(r.amount)), el("span", "wtab-row__usd", usdText(r.usd)));
    li.append(name, amt);
    return li;
  }
  /**
   * The line under the list: when the chain was read (the Worker's own time; no time when it gave none, never this browser's clock) and, when
   * the portfolio did not answer, that the city coins are missing (the route off: "not shown"; it failed: "could not be read").
   */
  function readLine(r) {
    const t = clock(r.at), when = t ? ` at ${t}` : "";
    const city = r.portfolioOk ? "" : r.portfolioOff ? " City coins are not shown right now." : " City coins could not be read right now.";
    return `Balances read from the Solana chain${when}.${city}`;
  }
  /** The balances card from the last answer: loading, the rows, "Nothing here yet", or that they could not be read; the time line and Refresh. */
  function balancesDraw() {
    const m = me(), w = m && m.user && m.user.wallet, r = walletData;
    if (!w) return;
    const state = !r || r.loading ? "loading" : !r.balances ? "unavailable" : "ready";
    const c = ctx && ctx.coin ? ctx.coin() : {};
    const rows = state === "ready" ? walletRows(r, { vicMint: c.vicMint || null, coin: c.coin || null, community: m.community || null }) : [];
    // "Nothing here yet" only when the city coins were read too; else the rows stand (at 0) and the line says what is missing
    const empty = state === "ready" && Boolean(r.portfolioOk) && rows.every((x) => !(x.amount > 0));
    $("#wt-loading").hidden = state !== "loading";
    $("#wt-empty").hidden = !empty;
    const list = $("#wt-rows"); list.hidden = state !== "ready" || empty;
    list.replaceChildren(...(list.hidden ? [] : rows.map(rowEl)));
    $("#wt-read").hidden = state === "loading";
    $("#wt-read-text").textContent = state === "ready" ? readLine(r) : state === "unavailable" ? "Balances could not be read right now." : "";
    $("#wt-refresh").disabled = state === "loading" || resting;
  }
  /** After every /api/me: the two cards show for a linked wallet (the address at once; the QR code and the balances when the tab is open). */
  function walletTab(d) {
    const u = d.user, w = u.wallet || null;
    $("#wt-receive").hidden = !w; $("#wt-balances").hidden = !w;
    if (!w) { walletData = null; qrFor = null; $("#wt-qr").hidden = true; return; }
    $("#wt-addr").textContent = w;
    if (walletData && walletData.owner !== w) walletData = null; // another wallet is linked now: its balances are read afresh
    if (qrFor && qrFor !== w) { qrFor = null; $("#wt-qr").hidden = true; }
    if (active === "wallet") enterWallet({ again: false }); // a wallet just linked or changed: its first read; otherwise no read (the tab entry and Refresh read)
    balancesDraw();
  }
  /** dashboard.js, with the answers (or that they are on their way). */
  function wallet(r) {
    const m = me();
    if (!r || !m || !m.user || r.owner !== m.user.wallet) return; // an answer for a wallet that is not the linked one any more
    walletData = r;
    if (!r.loading) { resting = true; clearTimeout(restTimer); restTimer = setTimeout(() => { resting = false; const b = $("#wt-refresh"); if (b) b.disabled = false; }, REST_MS); }
    balancesDraw();
  }

  /* ---------- what dashboard.js calls ---------- */
  function render(d) {
    $("#tab-home").classList.toggle("is-alert", !$("#ban-notice").hidden || !$("#lost-alert").hidden);
    reflow(() => { gate(); notifyGate(); unreadBadge(d.unread); }); // the roles (and the switch) can change on a refresh: a tab comes or goes as one glide
    placeCard(); standing(d); today(d); rankings(d); cityHeader(d); founderStatus(d); founderCard(d); studioSync(); postProcess(); walletTab(d);
  }
  function setCoin(c) {
    coin = c && c.coin ? c.coin : null; coinKnown = true;
    if (c && typeof c.launchLabClosed === "boolean") lab = c.launchLabClosed;
    const d = me(); if (!d) return;
    today(d); cityHeader(d); founderCard(d); studioSync(); postProcess(); balancesDraw();
  }
  /** The ready-made coin's answer (public/coin-ready.js, through dashboard.js): the Today strip, the City header and the Founder card follow it. */
  function setReady(r) {
    readyCoin = r || null; readyKnown = true;
    const d = me(); if (!d) return;
    today(d); cityHeader(d); founderCard(d);
  }
  function mod(d) {
    lastMod = d || null;
    reflow(() => { gate(); badge(); }); // /api/mod answers after the strip is on screen: the bar re-divides as one glide
    const m = me(); if (m) { today(m); founderCard(m); }
  }
  function coinQueue(n, closed) {
    coinQueueN = n;
    if (typeof closed === "boolean") lab = closed;
    $("#coin-admin-card").hidden = $("#coin-admin").hidden;
    reflow(badge);
    const m = me(); if (m) today(m);
  }

  /** The launch card's state (dashboard.js after LPLaunch.founder): the Today strip and the Founder card follow it. */
  function setLp(info) {
    lp = { on: Boolean(info && info.on), state: (info && info.state) || null };
    const d = me(); if (d) { today(d); founderCard(d); }
  }

  /** The Wallet tab's last answer and the rows drawn from it (null while loading or unread): what public/wallet-send.js lists as sendable. */
  function walletState() {
    const m = me(), r = walletData, c = ctx && ctx.coin ? ctx.coin() : {};
    const ready = Boolean(r && !r.loading && r.balances && m);
    return { data: r, rows: ready ? walletRows(r, { vicMint: c.vicMint || null, coin: c.coin || null, community: m.community || null }) : null };
  }
  window.VDash = { init, render, coin: setCoin, lp: setLp, ready: setReady, mod, coinQueue, wallet, walletRows, walletState, unread: (n) => reflow(() => unreadBadge(n)), start, go, goTo, placeCard, get active() { return active; }, TABS, ORDER, ALIAS: Object.freeze(ALIAS),
    pill: Object.freeze({ box: pillBox, frames: pillFrames, fromStyle: pillFromStyle, ms: PILL_MS, followMs: FOLLOW_MS, easing: PILL_EASE, easeIn: PILL_IN, easeOut: PILL_OUT }) };
})();
