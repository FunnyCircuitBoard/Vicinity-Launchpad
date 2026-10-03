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
//   home      -> #panel-home       #pf-notice, #ban-notice, #lost-alert, #dash-top, #today, #role-home, #portfolio, #badges, #trade
//   city      -> #panel-city       #city-subnav, #community, #coin, #city-about, #request
//   community -> #panel-community  #feed, #national
//   rankings  -> #panel-rankings   #rankings-card
//   founder   -> #panel-founder    #fcard, #progress, #squad, #studio-card (gets #coin-studio out of #coin), #founder-foot
//   moderate  -> #panel-moderate   #mod, #coin-admin-card (gets #coin-admin out of #coin)
//   profile   -> #panel-profile    #profile-modal (as an in-flow block), #profile-theme-note, #roles
//   strip                          #dash-tabs (#dash-tablist, the #tab-* links and the #panel-* sections above)
(() => {
  "use strict";
  const { $, $$, el, fmt, mask } = window.V;
  const byId = (id) => document.getElementById(id);

  const TABS = Object.freeze(["home", "city", "community", "rankings", "founder", "moderate", "profile"]);
  const LABEL = { home: "Home", city: "City", community: "Community", rankings: "Rankings", founder: "Founder", moderate: "Moderate", profile: "Profile" };
  // the cards, in the order they stand in each panel (the static v2 blocks are listed too, so the order is one list)
  const ORDER = Object.freeze({
    home: ["#pf-notice", "#ban-notice", "#lost-alert", "#dash-top", "#today", "#role-home", "#portfolio", "#badges", "#trade"],
    city: ["#city-subnav", "#community", "#coin", "#city-about", "#request"],
    community: ["#feed", "#national"],
    rankings: ["#rankings-card"],
    founder: ["#fcard", "#progress", "#squad", "#studio-card", "#founder-foot"],
    moderate: ["#mod", "#coin-admin-card"],
    profile: ["#profile-modal", "#profile-theme-note", "#roles"],
  });
  // a link to a card by its old hash (#progress, #coin, ...) opens the card's tab, then scrolls to the card
  const ALIAS = { progress: "founder", squad: "founder", "coin-studio": "founder", coin: "city", "cc-top": "city", request: "city", "city-about": "city",
    feed: "community", national: "community", mod: "moderate", roles: "profile", trade: "home", badges: "home", portfolio: "home", "role-home": "home" };
  const HEADER = 67; // the site header: 66px plus its 1px border
  const QUEUE = [["posts", "reported post", "reported posts"], ["proposals", "ban proposal", "ban proposals"], ["appeals", "appeal", "appeals"],
    ["objections", "objection", "objections"], ["towns", "town request", "town requests"], ["coins", "coin contract to check", "coin contracts to check"]];

  let ctx = null, active = "home", pending = null, lastMod = null, coin = null, coinKnown = false, coinQueueN = 0, fcardAction = null, lastTarget = null, targetTimer = 0;
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
  const coinState = () => (!coin ? "Not designed yet" : coin.launched ? "Live" : coin.waiting ? "Contract being checked" : "Designed");

  /* ---------- set-up: the cards move into their panels, the old two-column tools retire ---------- */
  function init(c) {
    ctx = c;
    for (const tab of TABS) {
      const panel = byId("panel-" + tab);
      for (const sel of ORDER[tab]) { const n = $(sel); if (n) panel.append(n); }
    }
    $("#studio-card").append($("#coin-studio"));
    $("#coin-admin-card").append($("#coin-admin"));
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
    $("#fcard-go").addEventListener("click", () => { if (fcardAction) fcardAction(); });
    $("#trade").addEventListener("click", postProcess); // dashboard.js redraws the trade card on its own clicks
    window.addEventListener("hashchange", onHash);
    window.addEventListener("resize", measure);
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
    const was = active;
    active = tab;
    for (const t of $$(".dtab")) { const on = t.dataset.tab === tab; t.setAttribute("aria-selected", String(on)); t.setAttribute("tabindex", on ? "0" : "-1"); }
    for (const p of $$(".dpanel")) p.hidden = p.id !== "panel-" + tab;
    document.title = tab === "home" ? "Dashboard · Vicinity" : `${LABEL[tab]} · Dashboard · Vicinity`;
    const url = location.pathname + location.search + "#" + tab;
    if (replace) history.replaceState(null, "", url);
    else if (push && was !== tab) history.pushState(null, "", url);
    if (scroll) { const y = dv2Top(); if (window.scrollY > y) window.scrollTo({ top: y, behavior: behavior() }); }
    centerTab(tab);
    if (tab === "profile" && ctx) ctx.openProfile();
    measure();
  }
  function centerTab(tab) {
    const list = $("#dash-tablist"), t = byId("tab-" + tab);
    if (!list || !t) return;
    const lr = list.getBoundingClientRect(), tr = t.getBoundingClientRect();
    list.scrollTo({ left: list.scrollLeft + (tr.left - lr.left) - (lr.width - tr.width) / 2, behavior: behavior() });
  }
  function measure() {
    const list = $("#dash-tablist"), strip = $("#dash-tabs");
    if (list && strip) strip.classList.toggle("is-scrollable", list.scrollWidth > list.clientWidth + 2);
  }
  /** Open the tab a card is in and scroll to the card (opening any <details> around it). */
  function goTo(selector, { focus = true, openRole, noAlias = false } = {}) {
    let sel = selector;
    if (!noAlias && sel === "#coin" && !$("#studio-card").hidden) sel = "#coin-studio"; // the founder lands on the studio, everyone else on the coin
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
    const tabs = $$(".dtab", $("#dash-tablist")).filter((t) => !t.hidden);
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
    if (seat && (seat.status === "grace" || (seat.status === "steward" && seat.graceUntil))) add("Top up your holding", `Hold ${fmt(seat.threshold)} $VICINITY again before ${when(seat.graceUntil)}`, "warn", "home", "#trade");
    if (seat && seat.status === "provisional") add("Objection period", `${seat.city} chose you · ends ${when(seat.appealUntil)}`, "info", "founder", "#progress");
    if (!seat && f.application) add(`You applied to found ${city}`, `Window closes ${when(f.application.closesAt)} (${left(f.application.closesAt)})`, "info", "founder", "#progress");
    if (!seat && !f.application && f.eligible) add(f.challenging ? `Challenge ${city}'s steward` : `Claim ${city}`, "You qualify. Apply from inside the city.", "ok", "founder", "#progress");
    const w = c && c.window;
    if (w && w.canEndorse && !w.myEndorsement && !(w.applicants || []).some((a) => a.you)) add("Endorse a founder", `${w.applicants.length} applying to found ${c.name} · ${left(w.closesAt)}`, "info", "founder", "#p-window");
    const e = n && n.election;
    if (e && e.canVote && !e.myVote) add("Vote for your Country Manager", `Election closes ${left(e.closesAt)}`, "info", "community", "#national");
    if (seated && coinKnown && !coin) add(`Design ${seat.city}'s coin`, "Name, pitch, pair, colour, logo. Public and logged.", "ok", "founder", "#coin-studio");
    if (seated && coin && !coin.mint && !coin.waiting) add("Add your coin's contract", "Launched it on Raydium LaunchLab? Send the address for a check.", "ok", "founder", "#cs-mint");
    if (seated && coin && coin.waiting) add("Contract being checked", "An admin checks it on the blockchain. Nothing to do.", "info", "city", "#coin", true);
    const q = queueCounts();
    if (modOn() && q.total > 0) add(`${q.total} waiting for you`, q.parts.join(" · "), "warn", "moderate", q.total === q.counts.coins ? "#coin-admin" : "#mod");
    if (sq && sq.joinable && !sq.joinable.full) add(`A squad is forming in ${city}`, `${sq.joinable.members.length} of ${sq.joinable.max} members · join to pool holdings`, "info", "founder", "#squad");
    if (sq && sq.mine && sq.mine.ready && sq.mine.status !== "applied") add("Your squad is ready", "Apply as a squad from inside the city.", "ok", "founder", "#squad");
    if (!u.handle) add("Pick a username", "Your public name everywhere on Vicinity.", "info", "profile", "#username-input");
    if (d.launched && h.amount === 0 && !seat) add("Get $VICINITY", "Holding any amount unlocks posting, voting and your rank.", "info", "home", "#trade");
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
    const fallback = launched ? (h.amount > 0 ? "ranking…" : "not holding yet") : "live at launch";
    tile("rk-global", h.rank ? `#${fmt(h.rank)}` : "—", h.rank ? `of ${fmt(h.total)} · top ${pctText(h.percentile)}%` : fallback);
    const gap = $("#rk-global-gap");
    gap.hidden = !(h.next && h.next.gap > 0);
    if (!gap.hidden) gap.textContent = `${fmt(h.next.gap)} $VICINITY to catch #${h.next.rank}`;
    board("rk-country", n, n ? countryName(n.country) : "Your country", fallback);
    board("rk-city", c, c ? c.name : "Your city", fallback);
    $("#rk-note").textContent = launched ? "Ranks count people, not pools or program accounts. Refreshed about every minute."
      : "Every rank goes live the moment $VICINITY launches. Your Early member badge is already yours.";
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
    return { no_home: ["Set your home", ""], home_too_new: ["Home too new", ""], not_qualified: f.tenure && f.tenure.days > 0 ? ["7-day clock running", "tag--gold"] : ["Below the bar", ""],
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
    gate();
    today(d); rankings(d); cityHeader(d); founderStatus(d); founderCard(d); studioSync(); postProcess();
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

  window.VDash = { init, render, coin: setCoin, mod, coinQueue, start, go, goTo, get active() { return active; }, TABS, ORDER, ALIAS: Object.freeze(ALIAS) };
})();
