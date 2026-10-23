// Admin: the control centre. Needs site.js (window.V) and wallets.js (window.VW); admin-charts.js (window.AdminCharts) draws the
// Overview's charts and admin-lp.js (window.AdminLP) the City coins tab. Design v4 (13 Oct 2026): a sidebar of sections grouped
// Monitor / Moderate / Launch / System (a row of chips under 1024 px), a top bar with the section's title, a live filter and when it
// was read; the Overview is metric cards, charts and the latest admin actions. Every number comes from an API answer and says where
// it came from; a missing one shows "—" and why. Who may see and do what is decided by the server exactly as before: this page only
// hides what the server would refuse. Only textContent: nothing from the server is ever HTML.
(() => {
  "use strict";
  const { $, el, api, toast, short, ago } = window.V;
  const W = window.VW;
  const LVL = { moderator: 1, admin: 2, owner: 3 };
  const TABS = [
    ["overview", "Overview", 1], ["inbox", "Inbox", 1], ["audit", "Audit", 1],
    ["moderation", "Moderation", 1], ["users", "Users", 1], ["seats", "Seats", 1], ["elections", "Elections", 1],
    ["tokens", "Tokens", 1], ["citycoins", "City coins", 3], ["snapshots", "Snapshots", 1],
    ["config", "Config", 2], ["roles", "Roles", 3], ["testlab", "Test lab", 3],
  ];
  const GROUPS = [["Monitor", ["overview", "inbox", "audit"]], ["Moderate", ["moderation", "users", "seats", "elections"]],
    ["Launch", ["tokens", "citycoins", "snapshots"]], ["System", ["config", "roles", "testlab"]]];
  // what the top bar's filter says on each section; a section without an entry has nothing to filter (no search box)
  const FILTER = { inbox: "Filter messages", audit: "Filter the log", moderation: "Filter this queue", seats: "Filter seats", elections: "Filter elections",
    tokens: "Filter tokens", snapshots: "Filter snapshots", config: "Filter settings", roles: "Filter roles" };
  // the sidebar's icons (24 px grid, 1.75 stroke, the site's set)
  const ICON = {
    overview: ["M4 4h7v9H4z", "M13 4h7v5h-7z", "M13 11h7v9h-7z", "M4 15h7v5H4z"],
    inbox: ["M4 13l2.6-7.2A2 2 0 0 1 8.5 4.5h7a2 2 0 0 1 1.9 1.3L20 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z", "M4 13h4.5l1.5 3h4l1.5-3H20"],
    audit: ["M12 8v4l3 2", "M3.5 12a8.5 8.5 0 1 0 2.5-6", "M3 4v4h4"],
    moderation: ["M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6z", "M9 12l2 2 4-4"],
    users: ["M15 20v-1.5A3.5 3.5 0 0 0 11.5 15h-5A3.5 3.5 0 0 0 3 18.5V20", "M9 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z", "M21 20v-1.5a3.5 3.5 0 0 0-2.5-3.4", "M15.5 4.6a3.5 3.5 0 0 1 0 6.8"],
    seats: ["M4 8l4 3.5L12 5l4 6.5L20 8l-1.5 10h-13z", "M6 21h12"],
    elections: ["M5 4h14v16H5z", "M9 12l2 2 4-4"],
    tokens: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M14.8 9c-.4-1-1.5-1.5-2.8-1.5-1.7 0-2.8.8-2.8 2s1.2 1.7 2.8 2 2.8.9 2.8 2.1-1.2 2-2.8 2c-1.4 0-2.5-.6-2.9-1.6", "M12 6v1.5", "M12 16.5V18"],
    citycoins: ["M12 15l-3-3c1.3-4 4.2-7 9-8 0 4.8-3 7.7-6 9z", "M9 12H5l2.5-3.5H11", "M12 15v4l3.5-2.5V13", "M6 16c-1 .7-1.6 2.6-1.6 3.6 1 0 2.9-.6 3.6-1.6"],
    snapshots: ["M4 8h3l1.6-2.5h6.8L17 8h3v11H4z", "M12 16a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"],
    config: ["M4 7h9", "M17 7h3", "M4 17h3", "M11 17h9", "M15 5v4", "M9 15v4"],
    roles: ["M14.5 4a5.5 5.5 0 0 1 0 11c-.7 0-1.4-.1-2-.4L10 17H8v2H6v2H3v-3l6.4-6.4A5.5 5.5 0 0 1 14.5 4z", "M16 8.5h.01"],
    testlab: ["M9 3h6", "M10 3v6l-5.4 9.5A1.7 1.7 0 0 0 6.1 21h11.8a1.7 1.7 0 0 0 1.5-2.5L14 9V3", "M7.5 15h9"],
  };
  let me = null, config = null, activeTab = "overview";
  let lpOn = false, lpProbe = null; // the City coins tab (public/admin-lp.js): only when the server has its settings (GET /api/admin/lp answers ok, with the cluster)
  let adapter = null, address = null, message = null;
  // the Inbox: how many messages are new (the badge on its tab and the browser title), refreshed every 20 seconds while the page is open
  const INBOX_POLL_MS = 20_000;
  let inboxNew = 0, inboxTimer = null;
  let inboxReload = null; // the Inbox tab's own reload while that tab is open: the poll calls it when the count moved, so the list is live too
  let feedReload = null;  // the Overview's live activity while that tab is open: the same poll refreshes it
  let usersQuery = null;  // the Users tab's server search while that tab is open (the top bar's filter asks the server there)
  let modSub = null;      // the Moderation queue last open (a decision keeps it open)
  let view = null, loadedAt = 0, tabSeq = 0;
  const baseTitle = document.title;

  const errBox = $("#admin-error");
  const setErr = (m) => { errBox.textContent = m || ""; errBox.hidden = !m; };
  const cancelled = (e) => /reject|cancel|denied|declin|closed/i.test(String(e?.message || e)) || e?.code === 4001;
  const can = (n) => me && LVL[me.role] >= n;
  const allowed = (id) => TABS.some(([t, , n]) => t === id && can(n) && (id !== "citycoins" || lpOn));
  const reducedNow = () => Boolean(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const int = (n) => Number(n || 0).toLocaleString("en-US");

  /** A stroke icon from the set above (null where the browser makes no SVG: the page still works without it). */
  function icon(name) {
    if (!document.createElementNS || !ICON[name]) return null;
    const NS = "http://www.w3.org/2000/svg", s = document.createElementNS(NS, "svg");
    for (const [k, v] of [["viewBox", "0 0 24 24"], ["width", "20"], ["height", "20"], ["fill", "none"], ["stroke", "currentColor"], ["stroke-width", "1.75"], ["stroke-linecap", "round"], ["stroke-linejoin", "round"], ["aria-hidden", "true"], ["focusable", "false"]]) s.setAttribute(k, v);
    for (const d of ICON[name]) { const p = document.createElementNS(NS, "path"); p.setAttribute("d", d); s.append(p); }
    return s;
  }

  /* ---------- sign-in ---------- */
  function renderGate() {
    const list = W.list();
    const box = $("#admin-wallets");
    if (list.length) {
      box.replaceChildren(...list.map((a) => {
        const b = el("button", "wallet-option"); b.type = "button";
        const ico = W.safeIcon(a.icon);
        if (ico) { const img = el("img"); img.alt = ""; img.src = ico; b.append(img); } else b.append(W.mark(a.name));
        b.append(el("span", null, a.name), el("span", "detected", "Sign"));
        b.addEventListener("click", () => pickWallet(a));
        return b;
      }));
    }
    // No wallet in this browser. Phones: open this page inside the wallet app, where its
    // wallet is injected and the normal connect flow works.
    else if (W.isMobile) {
      const openers = W.KNOWN.filter((k) => k.open);
      const rest = W.KNOWN.filter((k) => !k.open);
      const tile = (k, href, label, blank) => {
        const a = el("a", "wallet-option"); a.href = href;
        if (blank) { a.target = "_blank"; a.rel = "noopener"; }
        a.append(W.mark(k.name), el("span", null, k.name), el("span", "go", label));
        return a;
      };
      box.replaceChildren(
        el("p", "muted", "You're on a phone — open this page inside your wallet app, then connect it there."),
        ...openers.map((k) => tile(k, k.open(location.href), "Open app")),
        ...rest.map((k) => tile(k, k.site, "Get", true)),
      );
    } else {
      box.replaceChildren(el("p", "muted", "No wallet detected. Install Phantom or another Solana wallet, then reload."));
    }
    W.onChange(renderGateOnce);
  }
  let gateRendered = false;
  function renderGateOnce() { if (!gateRendered) { gateRendered = true; renderGate(); } }

  async function pickWallet(a) {
    setErr("");
    try {
      address = await a.connect(); adapter = a;
      $("#admin-addr").textContent = `Wallet: ${short(address)} (${a.name})`;
      const d = await api(`/api/message?address=${encodeURIComponent(address)}&action=login`);
      if (!d.message) return setErr("Couldn't prepare the message. Try again.");
      message = d.message;
      $("#admin-msg").textContent = message;
      $("#admin-sign").hidden = false;
    } catch (e) { setErr(cancelled(e) ? "Connection cancelled in your wallet." : "Couldn't connect. Please try again."); }
  }

  async function signIn() {
    setErr("");
    try {
      const sig = await adapter.signMessage(new TextEncoder().encode(message));
      const r = await api("/api/auth/wallet", { address, message, signature: btoa(String.fromCharCode(...sig)) });
      if (!r.ok) return setErr("Sign-in failed. Is this wallet linked to an account?");
      await loadMe();
    } catch (e) { setErr(cancelled(e) ? "Cancelled in your wallet." : "Couldn't sign. Try again."); }
  }

  /**
   * Every change needs a fresh wallet proof. When the server asks for one ("reprove"), sign
   * again with the wallet and retry once. After a page reload there is no wallet connected
   * yet; connect it first when there is only one to pick from.
   */
  async function sensitive(call) {
    let r = await call();
    if (r && r.error === "reprove") {
      try {
        if (!adapter) {
          const list = W.list();
          if (list.length !== 1) throw new Error("no wallet");
          address = await list[0].connect(); adapter = list[0];
        }
        if (me && address !== me.wallet) { toast(`Connect the wallet ${short(me.wallet)}, then try again.`); return r; }
        const d = await api(`/api/message?address=${encodeURIComponent(address)}&action=login`);
        if (!d.message) throw new Error("no message");
        const sig = await adapter.signMessage(new TextEncoder().encode(d.message));
        const p = await api("/api/auth/reprove", { address, message: d.message, signature: btoa(String.fromCharCode(...sig)) });
        if (!p.ok) { toast("Confirm in your wallet, then try again."); return r; }
        r = await call();
      } catch { toast("Confirm in your wallet, then try again."); }
    }
    return r;
  }

  /** A change to the site: wrapped in the re-sign flow like every other admin POST. */
  const post = (path, body) => sensitive(() => api(path, body));

  /** `quiet`: the check when the page opens. Signed out there is nothing to say yet: the card above already asks to sign in. */
  async function loadMe(quiet = false) {
    const d = await api("/api/admin/me");
    if (!d.ok || !d.role) {
      if (!(quiet && !d.ok)) setErr(d.ok ? "This wallet has no admin access. Ask the owner to grant it." : "Sign in first.");
      return;
    }
    me = d;
    $("#admin-gate").hidden = true;
    $("#admin-main").hidden = false;
    const badge = $("#admin-role");
    badge.textContent = me.role; badge.className = `role-badge ${me.role}`;
    $("#admin-who").textContent = short(me.wallet);
    config = can(2) ? await api("/api/admin/config").catch(() => null) : null; // admins and the owner only (a moderator's would be refused)
    // asked only when the server says the settings are there (config.cityCoins): a site without them sends no request for it
    lpProbe = me.role === "owner" && Boolean(config && config.cityCoins) ? await api("/api/admin/lp").catch(() => null) : null;
    lpOn = Boolean(lpProbe && lpProbe.ok);
    if (config && config.ok && config.siteMode === "preview") $("#admin-banner").hidden = false;
    renderTabs();
    const asked = (location.hash || "").slice(1);
    showTab(allowed(asked) ? asked : "overview");
    startInboxPolling();
    setInterval(stampNow, 5000);
  }

  /* ---------- the Inbox badge: new messages, every 20 seconds while this page is open ---------- */
  function setInboxNew(n) {
    if (n === inboxNew) return;
    inboxNew = n;
    const badge = $("#inbox-badge");
    if (badge) { badge.textContent = String(n); badge.hidden = !n; badge.setAttribute("aria-label", `${n} new`); }
    const line = $("#feed-inbox");
    if (line) line.textContent = inboxLine();
    const card = $("#ov-inbox-new"); // the Overview's "Inbox: new" card
    if (card) { card.textContent = int(n); const c = card.closest(".adm-metric"); if (c) c.classList.toggle("is-hot", n > 0); }
    document.title = n ? `(${n}) ${baseTitle}` : baseTitle;
  }
  const inboxLine = () => (inboxNew ? `${int(inboxNew)} new in the Inbox` : "Nothing new in the Inbox");
  async function pollInbox() {
    if (!me || document.visibilityState === "hidden") return; // a hidden tab asks again when it comes back
    const d = await api("/api/admin/feedback/count");
    if (d && d.ok) {
      const n = Number(d.new) || 0, moved = n !== inboxNew;
      setInboxNew(n);
      if (moved && activeTab === "inbox" && inboxReload) inboxReload();
    }
    if (activeTab === "overview" && feedReload) feedReload(); // the live activity: only while the Overview is open and the tab visible
  }
  function startInboxPolling() {
    if (inboxTimer) return;
    pollInbox();
    inboxTimer = setInterval(pollInbox, INBOX_POLL_MS);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") pollInbox(); });
  }

  /* ---------- the sidebar (chips on a phone) ---------- */
  function renderTabs() {
    const nav = $("#admin-tabs");
    const groups = [];
    for (const [name, ids] of GROUPS) {
      const items = ids.filter((id) => TABS.some(([t, , n]) => t === id && can(n) && (id !== "citycoins" || lpOn)));
      if (!items.length) continue;
      const g = el("div", "adm-nav__group"); g.setAttribute("role", "group");
      const label = el("p", "adm-nav__label", name); label.id = `adm-group-${name.toLowerCase()}`;
      g.setAttribute("aria-labelledby", label.id);
      g.append(label);
      for (const id of items) {
        const [, text] = TABS.find(([t]) => t === id);
        const b = el("button", "adm-nav__item"); b.type = "button"; b.dataset.tab = id;
        const ico = icon(id);
        if (ico) { const i = el("span", "adm-nav__ico"); i.append(ico); b.append(i); }
        b.append(el("span", "adm-nav__text", text));
        if (id === "inbox") { const badge = el("span", "tab-badge", String(inboxNew)); badge.id = "inbox-badge"; badge.hidden = !inboxNew; badge.setAttribute("aria-label", `${inboxNew} new`); b.append(badge); }
        b.addEventListener("click", () => showTab(id));
        g.append(b);
      }
      groups.push(g);
    }
    nav.replaceChildren(...groups);
  }
  /** The chosen section: marked for screen readers (aria-current) and for the eye; on a phone its chip scrolls into the row's view. */
  function markTab(id) {
    const nav = $("#admin-tabs");
    for (const b of nav.querySelectorAll(".adm-nav__item")) {
      if (b.dataset.tab === id) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    }
    const cur = nav.querySelector(`[data-tab="${id}"]`);
    if (cur && nav.scrollWidth > nav.clientWidth + 1 && typeof nav.scrollTo === "function") {
      nav.scrollTo({ left: Math.max(0, cur.offsetLeft - (nav.clientWidth - cur.offsetWidth) / 2), behavior: reducedNow() ? "auto" : "smooth" });
    }
  }
  const TAB_FN = () => ({ overview: tabOverview, inbox: tabInbox, audit: tabAudit, moderation: tabModeration, users: tabUsers, seats: tabSeats,
    elections: tabElections, tokens: tabTokens, citycoins: tabCityCoins, snapshots: tabSnapshots, config: tabConfig, roles: tabRoles, testlab: tabTestlab });
  /**
   * Opens a section. Each opening draws into a new view: a slow answer from the section left before can never land in this one.
   * opt.keep: keep what the filter holds (a refresh after a decision); opt.sub: the Moderation queue to open.
   */
  function showTab(id, opt = {}) {
    if (!allowed(id)) id = "overview";
    activeTab = id; markTab(id); inboxReload = null; feedReload = null; usersQuery = null;
    $("#admin-title").textContent = (TABS.find(([t]) => t === id) || [])[1] || "Overview";
    setupFilter(id, opt.keep);
    try { history.replaceState(null, "", id === "overview" ? location.pathname : `#${id}`); } catch { /* a sandboxed frame */ }
    const seq = ++tabSeq;
    view = el("div", `adm-view adm-view--${id}`);
    const loading = el("p", "muted adm-loading", "Loading…");
    view.append(loading);
    $("#admin-panel").replaceChildren(view);
    stamp(0);
    const p = view;
    TAB_FN()[id](p, opt).then(() => { loading.remove(); if (seq === tabSeq) { stamp(Date.now()); filterNow(); } })
      .catch((e) => p.replaceChildren(el("p", null, `Couldn't load: ${e.message}`)));
  }
  /** The City coins tab lives in public/admin-lp.js; it signs with the wallet this page signed in with (connected again after a reload). */
  async function lpWallet() {
    if (!adapter) {
      const list = W.list();
      if (list.length !== 1) throw new Error(list.length ? "Connect the wallet you signed in with: reload the page and sign in again." : "No wallet found in this browser.");
      address = await list[0].connect(); adapter = list[0];
    }
    return adapter;
  }
  const tabCityCoins = (p) => (window.AdminLP ? window.AdminLP.mount(p, { api, post, toast, el, short, me, wallet: lpWallet }) : Promise.resolve(p.replaceChildren(el("p", null, "Couldn't load the City coins tab."))));
  const h2 = (t) => el("h2", "adm-h2", t);
  const intro = (t) => el("p", "muted adm-intro", t);
  const refresh = () => showTab(activeTab, { keep: true, sub: modSub });

  /* ---------- the top bar: when this was read, and the live filter ---------- */
  function stamp(at) { loadedAt = at; stampNow(); }
  function stampNow() {
    const out = $("#admin-updated");
    if (!out) return;
    if (!loadedAt) { out.textContent = ""; return; }
    const s = Math.round((Date.now() - loadedAt) / 1000);
    out.textContent = s < 10 ? "Updated just now" : s < 60 ? `Updated ${Math.floor(s / 5) * 5} s ago` : `Updated ${ago(new Date(loadedAt).toISOString())}`;
  }
  const searchBox = $("#admin-search-box"), search = $("#admin-search"), count = $("#admin-count");
  let filterTimer = 0, userTimer = 0, filterQueued = 0;
  function setupFilter(id, keep) {
    const ph = id === "users" ? (can(2) ? "Search wallet or name" : "Search handle") : FILTER[id]; // short enough to show whole at 1440 px
    if (!keep) search.value = "";
    count.textContent = "";
    searchBox.hidden = !ph;
    if (ph) { search.placeholder = ph; search.setAttribute("aria-label", ph); }
  }
  /** Shows only the rows of the open section whose text holds what the filter says (case-insensitive); "n of m" beside it. */
  function filterNow() {
    if (!view) return;
    if (activeTab === "users") return; // the server searches there (usersQuery)
    const q = search.value.trim().toLowerCase();
    let shown = 0, all = 0;
    for (const t of view.querySelectorAll(".admin-table")) {
      if (t.closest(".chart__table")) continue;
      let vis = 0, n = 0;
      for (const tr of t.querySelectorAll("tbody tr")) {
        const hit = !q || tr.textContent.toLowerCase().includes(q);
        tr.hidden = !hit; n++; if (hit) vis++;
      }
      all += n; shown += vis;
      const none = t.parentNode && t.parentNode.querySelector(".adm-nomatch");
      if (none) none.hidden = !(q && n && !vis);
    }
    count.textContent = q ? `${shown} of ${all}` : "";
  }
  function onFilterInput() {
    if (activeTab === "users" && usersQuery) { clearTimeout(userTimer); userTimer = setTimeout(() => usersQuery(search.value), 300); return; }
    clearTimeout(filterTimer); filterTimer = setTimeout(filterNow, 120);
  }
  search.addEventListener("input", onFilterInput);
  search.addEventListener("keydown", (e) => { if (e.key === "Escape" && search.value) { e.preventDefault(); search.value = ""; onFilterInput(); } });
  // a section that redraws its rows (the Inbox when a message arrives, a queue after a decision): the filter applies to the new rows too
  if (window.MutationObserver) {
    new MutationObserver(() => {
      if (!search.value.trim() || filterQueued) return;
      filterQueued = window.requestAnimationFrame ? window.requestAnimationFrame(() => { filterQueued = 0; filterNow(); }) : setTimeout(() => { filterQueued = 0; filterNow(); }, 16);
    }).observe($("#admin-panel"), { childList: true, subtree: true });
  }
  $("#admin-refresh").addEventListener("click", () => refresh());

  /* ---------- tables and controls ---------- */
  /** A table; on a phone each row becomes a small card (every cell carries its column's name: data-label), unless `cards` is false. */
  function table(headers, rows, renderRow, { cards = true } = {}) {
    const wrap = el("div", "table-wrap adm-table-wrap");
    if (!rows.length) { wrap.classList.add("is-empty"); wrap.append(el("p", "empty adm-empty", "Nothing here.")); return wrap; }
    const t = el("table", cards ? "admin-table admin-table--cards" : "admin-table");
    const thead = el("thead"); const hr = el("tr");
    headers.forEach((hh) => { const th = el("th", null, hh); th.scope = "col"; if (!hh) th.append(el("span", "sr-only", "Actions")); hr.append(th); });
    thead.append(hr); t.append(thead);
    const tb = el("tbody");
    rows.forEach((r) => { const tr = el("tr"); renderRow(tr, r); [...tr.children].forEach((c, i) => { if (headers[i]) c.dataset.label = headers[i]; }); tb.append(tr); });
    t.append(tb); wrap.append(t);
    const none = el("p", "adm-nomatch", "No row matches the filter."); none.hidden = true; wrap.append(none);
    return wrap;
  }
  const WHEN = /^(just now|\d+[mhd] ago)$/; // a time ("5m ago") never breaks over two lines
  const td = (tr, text, cls) => { const t = text == null ? "—" : String(text); const c = el("td", cls || (WHEN.test(t) ? "adm-when" : null), t); tr.append(c); return c; };
  const monoTd = (tr, text) => td(tr, text, "mono");
  const actTd = (tr) => { const c = el("td", "adm-act"); tr.append(c); return c; };
  /** Ask before anything that cannot be undone with one click. */
  const sure = (msg) => window.confirm(msg);
  const btn = (label, fn, sm = true) => {
    const b = el("button", sm ? "btn btn--sm btn--glass" : "btn btn--primary", label); b.type = "button";
    b.addEventListener("click", async () => { b.disabled = true; try { await fn(); } finally { b.disabled = false; } });
    return b;
  };
  const field = (label, input) => {
    const f = el("label", "field adm-field"); f.append(el("span", "fieldset__label", label), input); return f;
  };
  const textInput = (ph = "", value = "") => { const i = el("input"); i.placeholder = ph; i.value = value; return i; };
  const ERRORS = {
    reprove: "Confirm in your wallet, then try again.", not_in_preview: "Only available on the preview site.",
    own_objection: "You can't decide your own objection.", outranked: "You can't act on someone of equal or higher role.",
    protected_wallet: "That wallet is an owner wallet (ADMIN_WALLETS).", owner_not_grantable: "Owners come from ADMIN_WALLETS only.",
    window_closed: "That claim window is closed.",
    needs_second_person: "A city's own founder can't decide their own coin. Another admin or the owner decides.",
    version_changed: "The founder changed this request since you opened it. Reload.", not_pending: "This request was decided, cancelled or withdrawn meanwhile. Reload.",
  };
  const okMsg = (r, what) => { if (r && r.ok) { toast(`${what} ✓`); refresh(); } else toast(r && ERRORS[r.error] ? ERRORS[r.error] : `Failed: ${r && r.error ? r.error : "unknown"}`); };
  const walletOf = (w) => (!w ? "no wallet" : w.includes("*") ? w : short(w)); // an account may have no wallet yet (it links one from its dashboard)
  /** A GET the next keystroke can cancel (the Users search): the same request V.api makes, with an AbortSignal. */
  async function getAbortable(path, signal) {
    try {
      const r = await fetch(path, { cache: "no-store", credentials: "same-origin", signal });
      const d = await r.json().catch(() => ({}));
      if (!r.ok && d.ok === undefined) d.ok = false;
      return d;
    } catch (e) { return { ok: false, error: e && e.name === "AbortError" ? "aborted" : "offline" }; }
  }

  /* ---------- tab: overview ---------- */
  /**
   * A metric card: label, value, an optional change (signed, against a named period, an arrow and a colour) and sparkline, and the
   * line that says where the number comes from. With no value it shows "—" and the reason, never a 0.
   */
  function metric(label, { attn = false } = {}) {
    const root = el("article", `card adm-metric${attn ? " adm-metric--attn" : ""}`);
    const top = el("div", "adm-metric__top");
    const h = el("h3", "adm-metric__label", label);
    top.append(h);
    const value = el("p", "adm-metric__value");
    const num = el("span", "adm-metric__num", "—");
    value.append(num);
    const delta = el("p", "adm-metric__delta"); delta.hidden = true;
    const spark = el("div", "adm-metric__spark");
    const src = el("p", "adm-metric__src", "Loading…");
    root.append(top, value, delta, spark, src);
    if (window.V.liveNums) window.V.liveNums([num]); // a plain count counts up once when it arrives; a price is written as it is
    const api_ = {
      root, top, num, src,
      set(text, { from, change, tag, action } = {}) {
        num.textContent = text; num.classList.remove("is-none");
        src.textContent = from || "";
        if (change) api_.change(change);
        if (tag) top.append(el("span", `tag tag--${tag.kind}`, tag.text));
        if (action) root.append(action);
        return api_;
      },
      /** The change line alone (the value stays as it is, its count-up included). */
      change(c) {
        delta.hidden = false; delta.className = `adm-metric__delta is-${c.dir}`; delta.textContent = c.text;
        if (c.label) { delta.setAttribute("aria-label", c.label); delta.setAttribute("role", "note"); }
        return api_;
      },
      none(why, { tag, action } = {}) {
        num.textContent = "—"; num.classList.add("is-none"); src.textContent = why;
        if (tag) top.append(el("span", `tag tag--${tag.kind}`, tag.text));
        if (action) root.append(action);
        return api_;
      },
      spark(svg) { if (svg) spark.replaceChildren(svg); return api_; },
      hot(on) { root.classList.toggle("is-hot", Boolean(on)); return api_; },
    };
    return api_;
  }
  const go = (label, id, sub) => {
    const b = el("button", "adm-metric__go", label); b.type = "button";
    b.addEventListener("click", () => { if (sub) modSub = sub; showTab(id, { sub }); });
    return b;
  };
  const usdCompact = (n) => `$${window.AdminCharts ? window.AdminCharts.compact(n) : int(Math.round(n))}`;
  const usd = (n) => (window.AdminCharts ? window.AdminCharts.usd(n) : `$${n}`);
  const dayMs = (d) => Date.parse(`${d}T00:00:00Z`);
  const todayUtc = () => new Date().toISOString().slice(0, 10);
  const countryName = (() => {
    let names = null;
    try { names = new Intl.DisplayNames(["en"], { type: "region" }); } catch { names = null; }
    return (cc) => { if (cc === "other") return "Other countries"; try { return (names && names.of(cc)) || cc; } catch { return cc; } };
  })();
  /** Jupiter's terms: its data shows with "Powered by Jupiter", linked. */
  function poweredByJupiter() {
    const a = el("a", null, "Powered by Jupiter"); a.href = "https://jup.ag"; a.target = "_blank"; a.rel = "noopener";
    return a;
  }

  /** Waits for `promise` at most `ms` (then goes on without it: what arrives later fills in place). */
  const atMost = (promise, ms) => Promise.race([promise.catch(() => null), new Promise((ok) => setTimeout(ok, ms))]);
  async function tabOverview(p) {
    const owner = me.role === "owner";
    const C = owner ? window.AdminCharts : null; // the charts read an owner-only answer: the others see the cards only
    // every answer asked for at once; the Overview is drawn when they are in (or after 2.5 s), so the cards appear with their numbers
    // and nothing below them moves when one arrives (layout shift)
    const ovP = api("/api/admin/overview");
    const official = api("/api/official").catch(() => null);
    const lpP = official.then((o) => (o && o.launchpadV2 ? api("/api/launchpad") : null));
    const policyP = api("/api/policy");
    const growthP = C ? api("/api/admin/growth") : Promise.resolve(null);
    const chartP = C ? official.then((o) => (o && o.launchpadV2 && o.tokenContract ? api(`/api/coin/chart?mint=${encodeURIComponent(o.tokenContract)}&tf=30d`) : null)) : Promise.resolve(null);
    const auditP = api(`/api/admin/audit?limit=${FEED_MAX}`);
    const ov = await ovP;
    if (!ov.ok) return p.replaceChildren(el("p", null, "Couldn't load overview."));
    await atMost(Promise.all([lpP, policyP, growthP, chartP, auditP].map((x) => x.catch(() => null))), 2500);
    const wrap = el("div", `adm-ov${C ? " has-charts" : ""}`);

    // key numbers: the community and the coin
    const kpis = el("section", "adm-ov__kpis"); kpis.setAttribute("aria-labelledby", "ov-kpis");
    const kh = h2("Key numbers"); kh.id = "ov-kpis"; kh.classList.add("sr-only");
    const grid = el("div", "adm-metrics");
    const M = {
      members: metric("Members"), holders: metric("$VICINITY holders"), price: metric("$VICINITY price"), volume: metric("24h volume"),
      mcap: metric("Market cap"), coins: metric("City coins live"), elections: metric("Open elections"), sampler: metric("Balance samples, 24 h"),
    };
    grid.append(...Object.values(M).map((m) => m.root));
    const attribution = el("p", "adm-attrib"); attribution.hidden = true;
    kpis.append(kh, grid, attribution);

    // what waits on a person
    const attn = el("section", "adm-ov__attn"); attn.setAttribute("aria-labelledby", "ov-attn");
    const ah = h2("Needs attention"); ah.id = "ov-attn";
    const agrid = el("div", "adm-metrics adm-metrics--attn");
    const A = { inbox: metric("Inbox: new", { attn: true }), reports: metric("Reported posts", { attn: true }), pictures: metric("Pictures waiting", { attn: true }),
      objections: metric("Seat objections", { attn: true }), seats: metric("Founder seats", { attn: true }) };
    // Meteora's two programs against the builds the team tested (src/programpins.js): only where the City coins tab exists; it lights
    // up whenever the answer is not "as tested", because approvals and launches wait then
    if (lpOn) A.meteora = metric("Meteora build", { attn: true });
    // city-coin requests waiting for a reviewer (COIN_V2_REVIEW on: /api/admin/me says coinReviews; nothing at all with the switch off)
    if (me && me.coinReviews) A.coinReviews = metric("Coin reviews", { attn: true });
    agrid.append(...Object.values(A).map((m) => m.root));
    attn.append(ah, agrid);

    wrap.append(kpis, attn);
    const holes = {};
    if (C) {
      const charts = el("section", "adm-ov__charts"); charts.setAttribute("aria-labelledby", "ov-charts");
      const ch = h2("Growth"); ch.id = "ov-charts";
      const cg = el("div", "adm-charts");
      for (const k of ["holders", "members", "countries", "price"]) { holes[k] = el("div", "card adm-chart"); holes[k].append(el("p", "muted adm-chart__wait", "Loading…")); cg.append(holes[k]); }
      charts.append(ch, cg);
      wrap.append(charts);
    }
    const feed = feedCard();
    wrap.append(feed.root);
    p.append(wrap);

    // the numbers the server keeps itself
    M.members.set(int(ov.users), { from: "Accounts on vicinity.city" });
    M.coins.set(int(ov.launchedCityCoins), { from: "City coins with a recorded contract" });
    M.elections.set(int(ov.openElections), { from: "Country votes open now" });
    A.reports.set(int(ov.pendingReports), { from: "Posts with open reports", action: go("Review", "moderation", "reports") }).hot(ov.pendingReports > 0);
    // coin pictures a founder uploaded that no admin has looked at yet (the badge shows meanwhile); an old server's answer has no count
    if (ov.pendingLogos == null) A.pictures.none("Not counted by this server yet", { action: go("Review", "moderation", "logos") });
    else A.pictures.set(int(ov.pendingLogos), { from: "Coin pictures waiting for a check", action: go("Review", "moderation", "logos") }).hot(ov.pendingLogos > 0);
    A.objections.set(int(ov.pendingObjections), { from: "Open objections to a founder seat", action: go("Review", "moderation", "objections") }).hot(ov.pendingObjections > 0);
    if (A.coinReviews) {
      if (ov.pendingCoinReviews == null) A.coinReviews.none("Not counted by this server yet", { action: go("Review", "moderation", "coinreviews") });
      else A.coinReviews.set(int(ov.pendingCoinReviews), { from: "Coin change requests and descriptions waiting for a reviewer", action: go("Review", "moderation", "coinreviews") }).hot(ov.pendingCoinReviews > 0);
    }
    A.inbox.set(int(inboxNew), { from: "Questions, bug reports and city requests", action: go("Open inbox", "inbox") }).hot(inboxNew > 0);
    A.inbox.num.id = "ov-inbox-new";
    const seatRows = Object.entries(ov.seats || {}).sort((a, b) => b[1] - a[1]);
    const seatTotal = seatRows.reduce((s, [, n]) => s + n, 0);
    A.seats.set(int(seatTotal), { from: seatRows.length ? seatRows.map(([st, n]) => `${int(n)} ${st}`).join(" · ") : "No seat yet", action: go("Open seats", "seats") });
    if (A.meteora) {
      const hhmm = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      api(`/api/admin/lp/pins?cluster=${encodeURIComponent(lpProbe.cluster)}`).catch(() => null).then((r) => {
        const m = r && r.ok ? r.meteora : null;
        if (m && m.state === "ok") A.meteora.set("OK", { from: `Both Meteora programs are the builds the team tested · checked ${hhmm(m.checkedAt)}` });
        else if (m && m.state === "changed") A.meteora.set("Changed", { from: `${m.which.map((k) => ({ dbc: "Bonding curve", dammV2: "DAMM v2" })[k] || k).join(" and ")} changed · approvals and launches wait`, action: go("Open City coins", "citycoins") }).hot(true);
        else A.meteora.set("Unknown", { from: "Meteora's programs could not be checked just now; approvals and launches wait until they can", action: go("Open City coins", "citycoins") }).hot(true);
      });
    }

    // the rest, from the answers asked for above (a late one fills its card when it comes)
    const market = Promise.all([official, lpP]).then(([o, lp]) => {
      if (!o || !o.launchpadV2) {
        const why = o ? "The Launchpad list is switched off on this site" : "Couldn't reach /api/official";
        for (const k of ["holders", "price", "volume", "mcap"]) M[k].none(why);
        return null;
      }
      fillMarket(M, attribution, lp);
      return lp;
    });
    const jobs = [
      market,
      policyP.then((d) => fillSampler(M.sampler, d)).catch(() => M.sampler.none("Couldn't reach /api/policy")),
      feed.load(auditP),
    ];
    if (C) jobs.push(fillCharts(C, holes, M, { official, growthP, chartP, market }));
    await Promise.all(jobs.map((j) => j.catch(() => null)));
  }

  function fillMarket(M, attribution, lp) {
    if (!lp || !lp.ok) { for (const k of ["holders", "price", "volume", "mcap"]) M[k].none("Couldn't reach /api/launchpad"); return; }
    const v = lp.vicinity || {};
    const h = v.holders;
    if (!v.mint) M.holders.none("No official contract yet");
    else if (h && h.count != null) M.holders.set(int(h.count), { from: `People only, pools and team wallets left out · counted ${ago(h.asOf)}` });
    else M.holders.none("Not counted yet: the scheduled job counts holders every 10 minutes");
    const m = v.market;
    if (!v.mint || !m) { const why = v.mint ? "No market answer yet" : "No official contract yet"; for (const k of ["price", "volume", "mcap"]) M[k].none(why); return; }
    const from = (key) => `${m.sources && m.sources[key] ? m.sources[key] : "—"}${m.stale ? " · a delayed copy" : ""}`;
    const tag = m.stale ? { kind: "warn", text: "Delayed" } : null;
    if (m.priceUsd != null) {
      const ch = m.priceChange24hPct;
      const change = ch == null ? null : { dir: ch > 0 ? "up" : ch < 0 ? "down" : "flat", text: `${ch > 0 ? "▲" : ch < 0 ? "▼" : "■"} ${Math.abs(ch).toFixed(1)}% · 24 h`,
        label: `${ch > 0 ? "Up" : ch < 0 ? "Down" : "Unchanged"} ${Math.abs(ch).toFixed(1)}% in 24 hours (${m.sources && m.sources.change24h ? m.sources.change24h : "source unknown"})` };
      M.price.set(usd(m.priceUsd), { from: from("price"), change, tag });
    } else M.price.none((m.missing && m.missing.price) || "No price yet");
    if (m.volume24hUsd != null) M.volume.set(usdCompact(m.volume24hUsd), { from: from("volume24h") });
    else M.volume.none((m.missing && m.missing.volume24h) || "No 24 h volume yet");
    if (m.marketCapUsd != null) M.mcap.set(usdCompact(m.marketCapUsd), { from: from("marketCap") });
    else M.mcap.none((m.missing && m.missing.marketCap) || "No market cap yet");
    if ((lp.attribution || []).some((a) => /Jupiter/.test(a.text))) { attribution.replaceChildren(poweredByJupiter()); attribution.hidden = false; }
  }

  function fillSampler(card, d) {
    const b = d && d.balanceHistory;
    if (!b) { card.none("Couldn't read the sampler"); return; }
    if (!b.running || !b.lastSample) { card.none("No balance sample yet", { tag: { kind: "no", text: "Not started" } }); return; }
    const maxGap = (d.policy && d.policy.sampling && d.policy.sampling.maxGapMinutes) || 180;
    const late = Date.now() - Date.parse(b.lastSample.taken_at) > maxGap * 2 * 60_000; // the rule src/ledger.js uses
    card.set(int(b.samplesLast24h), { from: `Last sample ${ago(b.lastSample.taken_at)}${late ? `: more than ${Math.round((maxGap * 2) / 60)} h ago` : ""}`,
      tag: late ? { kind: "warn", text: "Late" } : { kind: "ok", text: "Running" } });
  }

  /** The owner's charts (GET /api/admin/growth, owner only) and the 30-day price line (the public /api/coin/chart). */
  async function fillCharts(C, holes, M, { official, growthP, chartP, market }) {
    const [g, o] = await Promise.all([growthP, official]);
    if (!g || !g.ok) {
      for (const k of ["holders", "members", "countries"]) holes[k].replaceChildren(el("p", "chart__empty", "Couldn't load /api/admin/growth."));
    } else {
      C.line(holes.holders, g.holders.map((r) => ({ t: dayMs(r.day), v: r.holders })), {
        title: "Wallets holding $VICINITY", sub: "The last balance sample of each day; pools and team wallets included", height: 200, whole: true,
        endLabel: (v) => `${int(v)} wallets`, fmt: (v) => `${int(v)} wallets`, head: ["Day", "Wallets"],
        empty: "No balance samples yet: the sampler records about once an hour.",
      });
      // the last 30 UTC days, one column each, the days without a new account as 0
      const byDay = new Map(g.members.map((r) => [r.day, r.joined]));
      const days = [];
      for (let i = 29; i >= 0; i--) { const t = dayMs(todayUtc()) - i * 86400000; days.push({ t, v: byDay.get(new Date(t).toISOString().slice(0, 10)) || 0 }); }
      C.columns(holes.members, days, {
        title: "New members per day", sub: "Accounts made each UTC day, last 30 days; test accounts left out", height: 200, emptyWhenZero: true,
        fmt: (v) => `${int(v)} new`, head: ["Day", "New members"], empty: g.members.length ? "No new accounts in the last 30 days." : "No accounts made in the last 90 days.",
      });
      C.bars(holes.countries, g.countries.map((r) => ({ label: countryName(r.country), v: r.members })), {
        title: "Members by country", sub: "Home country of each account; the 12 largest, then the rest", minHeight: 200,
        fmt: int, head: ["Country", "Members"], empty: "No member has a home city yet.",
      });
      // the Members card: today's new accounts and the running total of the last 12 days (owner only: this answer is the owner's)
      const today = g.members.find((r) => r.day === todayUtc());
      const n = today ? today.joined : 0;
      M.members.change({ dir: n ? "up" : "flat", text: `+${int(n)} today`, label: `${int(n)} new accounts today (UTC)` });
      if (g.members.length) {
        const base = g.members[0].total - g.members[0].joined, totals = [];
        for (let i = 11; i >= 0; i--) {
          const d = new Date(dayMs(todayUtc()) - i * 86400000).toISOString().slice(0, 10);
          const last = [...g.members].reverse().find((r) => r.day <= d);
          totals.push(last ? last.total : base);
        }
        M.members.spark(C.spark(totals));
      }
    }
    const mint = o && o.launchpadV2 && o.tokenContract;
    if (!mint) {
      C.line(holes.price, [], { title: "$VICINITY price, 30 days", height: 200, empty: o && !o.launchpadV2 ? "The Launchpad list is switched off on this site." : "No official contract yet." });
      return;
    }
    const ch = await chartP;
    const line = ch && ch.ok && ch.line ? ch.line : null;
    const pts = line ? line.points.filter((x) => x[1] != null).map((x) => ({ t: x[0] * 1000, v: x[1] })) : [];
    let note = null; // Jupiter's line goes with Jupiter's numbers: only when the chart shows them
    if (pts.length) { note = el("span"); note.append(`One point per ${line.interval}, sampled by vicinity.city from Jupiter's last-trade price · `, poweredByJupiter()); }
    C.line(holes.price, pts, {
      title: "$VICINITY price, 30 days", sub: "US dollars", height: 200, zero: false, when: "time", fmt: usd, tick: usd, head: ["Time", "Price (USD)"], note,
      empty: (ch && ch.missing && ch.missing.line) || (ch && ch.ok ? "No price sample in the last 30 days." : "Couldn't load /api/coin/chart."),
    });
    await market.catch(() => null);
    // the price card's sparkline: only beside a price (a history next to "—" would read as today's number)
    if (pts.length > 1 && !M.price.num.classList.contains("is-none")) M.price.spark(C.spark(pts.slice(-12).map((x) => x.v)));
  }

  /* the live activity: the last 15 admin actions (GET /api/admin/audit), refreshed by the Inbox poll while the Overview is open */
  const SAY = {
    "users/ban": "Banned an account", "users/unban": "Lifted a ban", "seats/decide": "Decided a founder claim", "objections/decide": "Decided a seat objection",
    "elections/create": "Opened an election", "tokens/register": "Registered a token", "reports/hide": "Hid a reported post", "reports/dismiss": "Dismissed the reports on a post", "appeals/decide": "Decided a ban appeal",
    "snapshots/create": "Created a snapshot", "roles/grant": "Granted a role", "roles/revoke": "Revoked a role", "feedback/update": "Updated an Inbox message",
    "feedback/delete": "Deleted an Inbox message", "test/seed": "Seeded test data", "test/reset": "Wiped test data", "test/preview-role": "Previewed the site as a role",
    "admin/bootstrap": "Owner account set up",
  };
  const FEED_MAX = 15;
  /** A log row's target: a wallet shortened (a moderator's is already masked), anything else cut at 40 characters. */
  const targetOf = (t) => { const s = String(t); return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) ? short(s) : s.length > 40 ? `${s.slice(0, 40)}…` : s; };
  function feedCard() {
    const root = el("section", "card adm-feed"); root.setAttribute("aria-labelledby", "ov-feed");
    const head = el("div", "adm-feed__head");
    const t = h2("Live activity"); t.id = "ov-feed";
    const live = el("p", "adm-feed__live"); const dot = el("span", "live-dot"); dot.setAttribute("aria-hidden", "true");
    live.append(dot, " Every 20 s");
    head.append(t, live);
    const list = el("ol", "adm-feed__list"); list.setAttribute("aria-label", "The latest admin actions, newest first");
    const foot = el("div", "adm-feed__foot");
    const line = el("span", null, inboxLine()); line.id = "feed-inbox";
    foot.append(line, go("Open inbox", "inbox"));
    root.append(head, list, foot);
    let lastId = 0, first = true;
    const row = (a) => {
      const li = el("li", "adm-feed__item");
      const what = el("p", "adm-feed__what");
      what.append(el("strong", null, SAY[a.action] || (/^lp\//.test(a.action) ? `City coins: ${a.action.slice(3)}` : a.action)));
      if (a.target) what.append(" ", el("span", "mono", targetOf(a.target)));
      const meta = el("p", "adm-feed__meta", `by ${walletOf(a.actor)}${a.detail ? ` · ${String(a.detail).slice(0, 80)}` : ""}`);
      const when = el("time", "adm-feed__when", ago(a.created_at)); when.dateTime = a.created_at;
      const body = el("div", "adm-feed__body"); body.append(what, meta);
      li.append(body, when);
      return li;
    };
    async function load(asked) {
      const d = await (asked || api(`/api/admin/audit?limit=${FEED_MAX}`));
      if (!d || !d.ok) { if (first) list.replaceChildren(el("li", "adm-feed__none", "Couldn't load the log.")); return; }
      const rows = d.audit || [];
      if (first) {
        first = false;
        list.replaceChildren(...(rows.length ? rows.map(row) : [el("li", "adm-feed__none", "No admin action yet.")]));
        lastId = rows.length ? rows[0].id : 0;
      } else {
        const fresh = rows.filter((a) => a.id > lastId).reverse(); // oldest of the new ones first, so the newest ends on top
        if (fresh.length) {
          const none = list.querySelector(".adm-feed__none"); if (none) none.remove();
          for (const a of fresh) {
            const li = row(a);
            list.prepend(li);
            if (!reducedNow() && li.animate) li.animate([{ opacity: 0, transform: "translateY(-8px)" }, { opacity: 1, transform: "none" }], { duration: 240, easing: "cubic-bezier(.2,.8,.2,1)" });
          }
          lastId = fresh[fresh.length - 1].id;
          while (list.children.length > FEED_MAX) list.lastElementChild.remove(); // 15 rows, always: the card never grows
        }
        for (const t of list.querySelectorAll("time")) if (t.dateTime) t.textContent = ago(t.dateTime); // the times move on
        stamp(Date.now());
      }
    }
    feedReload = () => load();
    return { root, load };
  }

  /* ---------- tab: inbox (the Feedback / Support messages, src/feedback.js) ---------- */
  const KIND_LABEL = { question: "Question", bug: "Bug report", city: "City request" };
  const kindTag = (kind) => el("span", `inbox-kind inbox-kind--${kind}`, KIND_LABEL[kind] || kind);
  const fromOf = (x) => (x.handle ? `@${String(x.handle).replace(/^@/, "")}` : x.user_id ? `member #${x.user_id}` : "visitor (not signed in)");
  async function tabInbox(p) {
    p.append(intro("Questions, bug reports and city requests sent with the Feedback button on every page, newest first. Open one to read it, mark it seen or done, copy the e-mail and leave a note for the team. The list refreshes by itself when a new message arrives."));
    const row = el("div", "admin-row");
    const status = el("select");
    [["open", "new & seen"], ["new", "new"], ["seen", "seen"], ["done", "done"], ["all", "all"]].forEach(([v, l]) => { const o = el("option", null, l); o.value = v; status.append(o); });
    const kind = el("select");
    [["", "all kinds"], ["question", "questions"], ["bug", "bug reports"], ["city", "city requests"]].forEach(([v, l]) => { const o = el("option", null, l); o.value = v; kind.append(o); });
    row.append(field("Status", status), field("Kind", kind), btn("Refresh", () => load()));
    p.append(row);
    const counts = el("p", "muted small adm-counts"); counts.id = "inbox-counts"; p.append(counts);
    const detail = el("div"); detail.id = "inbox-detail"; p.append(detail);
    const list = el("div"); list.id = "inbox-list"; p.append(list);
    let openId = null, shown = null; // the open message's id and the row it was drawn from
    status.addEventListener("change", () => load()); kind.addEventListener("change", () => load());
    /** After a change: say so, show the item as the server now has it, then reload the list in place (the filters stay). */
    const changed = async (r, what) => { if (r && r.ok) { toast(`${what} ✓`); if (r.item) show(r.item); await load(); } else toast(r && ERRORS[r.error] ? ERRORS[r.error] : `Failed: ${r && r.error ? r.error : "unknown"}`); return r; };
    const closeItem = () => { openId = null; shown = null; detail.replaceChildren(); };
    async function load() {
      const d = await api(`/api/admin/feedback?status=${encodeURIComponent(status.value)}&kind=${encodeURIComponent(kind.value)}&limit=100`);
      if (!d.ok) { list.replaceChildren(el("p", null, "Couldn't load the inbox.")); return; }
      setInboxNew(Number(d.counts.new) || 0);
      counts.textContent = `${d.counts.new} new · ${d.counts.seen} seen · ${d.counts.done} done`;
      list.replaceChildren(table(["When", "Kind", "From", "Message", "Page", "Status", ""], d.items, (tr, x) => {
        if (x.status === "new") tr.className = "inbox-row--new";
        td(tr, ago(x.created_at));
        const k = el("td"); k.append(kindTag(x.kind)); tr.append(k);
        td(tr, fromOf(x));
        const text = x.kind === "city" ? `${x.city}, ${x.country}${x.message ? " — " + x.message : ""}` : x.message || "";
        td(tr, text.slice(0, 90), "inbox-preview");
        monoTd(tr, x.page || "—");
        td(tr, x.status, `inbox-status inbox-status--${x.status}`);
        const act = actTd(tr); act.append(btn("Open", () => show(x, true)));
      }, { cards: false })); // the Inbox has its own phone cards (admin.css #inbox-list)
      if (d.more) list.append(el("p", "muted small", "The newest 100 are shown; narrow the filters for older ones."));
      stamp(Date.now());
      // the open item stays open, redrawn only when the server's row changed (so a note being typed is never disturbed), and it
      // stays even when the filters no longer list it (the admin closes it)
      if (openId) {
        const again = d.items.find((i) => i.id === openId);
        if (again && (!shown || again.updated_at !== shown.updated_at || again.status !== shown.status || (again.admin_note || "") !== (shown.admin_note || ""))) show(again);
      }
    }
    /**
     * The open message, above the list. `scroll`: it was just opened from a row (which may be far down), so bring it into view.
     * A note typed but not yet saved survives a redraw of the same item (keyboard and caret included) and travels with the next
     * status change, so Mark seen / done never throws typing away.
     */
    function show(x, scroll = false) {
      const old = $("#inbox-note");
      const typed = old && openId === x.id && old.value !== ((shown && shown.admin_note) || "")
        ? { value: old.value, focus: document.activeElement === old, start: old.selectionStart, end: old.selectionEnd } : null;
      openId = x.id; shown = x;
      const box = el("div", "card inbox-item"); box.id = "inbox-item";
      const hd = el("div", "inbox-item__head");
      hd.append(el("h3", null, `#${x.id}`), kindTag(x.kind), el("span", `inbox-status inbox-status--${x.status}`, x.status), el("span", "muted small", ago(x.created_at)));
      box.append(hd);
      if (x.kind === "city") box.append(el("p", null, `${x.city}, ${x.country}`));
      box.append(el("p", "inbox-msg", x.message || "(no message)"));
      const facts = el("dl", "inbox-facts");
      const fact = (k, v) => { facts.append(el("dt", null, k)); const dd = el("dd"); if (v && typeof v === "object") dd.append(v); else dd.textContent = v == null || v === "" ? "—" : String(v); facts.append(dd); };
      fact("From", fromOf(x));
      if (x.email && x.email !== "(hidden)") { const s = el("span"); s.append(el("span", "mono", x.email), " ", btn("Copy", () => window.V.copy(x.email, "E-mail copied"))); fact("E-mail", s); }
      else fact("E-mail", x.email === "(hidden)" ? "hidden for moderators" : "none given");
      if (x.page) { const a = el("a", "mono", x.page); a.href = x.page; a.target = "_blank"; a.rel = "noopener"; fact("Page", a); } else fact("Page", null);
      fact("Browser", x.ua);
      fact("Updated", x.updated_at ? ago(x.updated_at) : null);
      box.append(facts);
      // the note first (the status buttons send it along when it changed)
      const note = el("textarea"); note.id = "inbox-note"; note.maxLength = 500; note.value = typed ? typed.value : (x.admin_note || ""); note.placeholder = "A note for the team (never sent to the person)";
      const noteChanged = () => note.value !== (x.admin_note || "");
      const hint = el("p", "muted small inbox-note-hint", "Unsaved note: it is saved with Save note, Mark seen or Mark done."); hint.id = "inbox-note-hint"; hint.hidden = !noteChanged();
      note.addEventListener("input", () => { hint.hidden = !noteChanged(); });
      const withNote = (body) => (noteChanged() ? { ...body, note: note.value } : body);
      const acts = el("div", "admin-row");
      const setStatus = (s, label) => btn(label, async () => changed(await post("/api/admin/feedback/update", withNote({ id: x.id, status: s })), `Marked ${s}`));
      if (x.status !== "seen") acts.append(setStatus("seen", "Mark seen"));
      if (x.status !== "done") acts.append(setStatus("done", "Mark done"));
      if (x.status !== "new") acts.append(setStatus("new", "Reopen"));
      if (can(2)) acts.append(btn("Delete", async () => {
        if (!sure("Delete this message for good? The text, the e-mail and the note go with it (the deletion itself is logged).")) return;
        const r = await post("/api/admin/feedback/delete", { id: x.id });
        if (r && r.ok) { toast("Deleted ✓"); closeItem(); await load(); } else toast(r && ERRORS[r.error] ? ERRORS[r.error] : `Failed: ${r && r.error ? r.error : "unknown"}`);
      }));
      acts.append(btn("Close", () => { if (noteChanged() && !sure("Close without saving the note?")) return; closeItem(); }));
      box.append(acts);
      const noteRow = el("div", "admin-row");
      noteRow.append(field("Admin note", note), btn("Save note", async () => changed(await post("/api/admin/feedback/update", { id: x.id, note: note.value }), "Note saved")));
      box.append(noteRow, hint);
      detail.replaceChildren(box);
      if (typed && typed.focus) { note.focus({ preventScroll: true }); try { note.setSelectionRange(typed.start, typed.end); } catch { /* not every browser */ } }
      if (scroll && typeof box.scrollIntoView === "function") box.scrollIntoView({ block: "start" });
    }
    inboxReload = load;
    await load();
  }

  /* ---------- tab: moderation (founder claims, reported posts, seat objections, ban appeals) ---------- */
  async function tabModeration(p, opt = {}) {
    p.append(intro("Everything that waits on a moderator, in one place. Every decision asks first, is logged, and claims and objections need an admin."));
    const queues = [];
    // Claims: admins and the owner only, as before (deciding one needs an admin)
    if (can(2)) queues.push({ id: "claims", label: "Claims", load: () => api("/api/admin/claims"), list: (d) => d.claims, draw: claimsTable, fail: "Couldn't load claims." });
    queues.push(
      { id: "reports", label: "Reports", load: () => api("/api/admin/reports"), list: (d) => d.reports, draw: reportsTable, fail: "Couldn't load reports." },
      // coin pictures: the list holds what waits and what was decided lately; the count is what waits (every role may look, admins decide)
      { id: "logos", label: "Pictures", load: () => api("/api/admin/logos"), list: (d) => d.logos, count: (d) => d.waiting, draw: picturesTable, fail: "Couldn't load pictures." },
      { id: "objections", label: "Objections", load: () => api("/api/admin/objections"), list: (d) => d.objections, draw: objectionsTable, fail: "Couldn't load objections." },
      { id: "appeals", label: "Appeals", load: () => api("/api/admin/appeals"), list: (d) => d.appeals, draw: appealsTable, fail: "Couldn't load appeals." },
    );
    // city-coin change requests and descriptions (COIN_V2_REVIEW on only: /api/admin/me says coinReviews); every role may look, admins decide
    if (me && me.coinReviews) {
      queues.splice(queues.findIndex((q) => q.id === "objections"), 0,
        { id: "coinreviews", label: "Coin reviews", load: () => api("/api/admin/coins/reviews"), list: (d) => d, count: (d) => d.pending, draw: coinReviewsList, fail: "Couldn't load coin reviews." });
    }
    const answers = await Promise.all(queues.map((q) => q.load()));
    const bar = el("div", "seg adm-subtabs"); bar.setAttribute("role", "tablist"); bar.setAttribute("aria-label", "Moderation queues");
    const panel = el("div", "adm-subpanel"); panel.id = "mod-panel"; panel.setAttribute("role", "tabpanel"); panel.tabIndex = 0;
    const waiting = (q, d) => (q.count ? Number(q.count(d)) || 0 : (q.list(d) || []).length);
    const tabs = queues.map((q, i) => {
      const d = answers[i], n = d && d.ok ? waiting(q, d) : null;
      const b = el("button", "adm-subtab"); b.type = "button"; b.id = `mod-tab-${q.id}`;
      b.setAttribute("role", "tab"); b.setAttribute("aria-controls", "mod-panel");
      b.append(el("span", null, q.label));
      if (n != null) { const c = el("span", `adm-count${n ? " is-on" : ""}`, String(n)); c.setAttribute("aria-label", `${n} waiting`); b.append(c); }
      b.addEventListener("click", () => pick(i, true));
      b.addEventListener("keydown", (e) => {
        const k = e.key, last = queues.length - 1;
        const j = k === "ArrowRight" ? (i === last ? 0 : i + 1) : k === "ArrowLeft" ? (i ? i - 1 : last) : k === "Home" ? 0 : k === "End" ? last : null;
        if (j == null) return;
        e.preventDefault(); pick(j, true); tabs[j].focus();
      });
      bar.append(b);
      return b;
    });
    function pick(i, byHand) {
      modSub = queues[i].id;
      tabs.forEach((b, j) => { b.setAttribute("aria-selected", j === i ? "true" : "false"); b.tabIndex = j === i ? 0 : -1; });
      panel.setAttribute("aria-labelledby", tabs[i].id);
      const d = answers[i];
      panel.replaceChildren(!d || !d.ok ? el("p", null, queues[i].fail) : queues[i].draw(queues[i].list(d) || []));
      if (byHand) filterNow();
    }
    // the queue asked for (a card on the Overview, or the one open before a decision), else the first that has something waiting
    let start = queues.findIndex((q) => q.id === (opt.sub || modSub));
    if (start < 0) start = Math.max(0, queues.findIndex((q, i) => answers[i] && answers[i].ok && waiting(q, answers[i])));
    p.append(bar, panel);
    pick(start, false);
  }
  const claimsTable = (claims) => table(
    ["City", "Claimant", "Pitch", "Score", ""],
    claims,
    (tr, a) => {
      td(tr, `${a.city_name} (${a.country})`); td(tr, a.handle || walletOf(a.wallet));
      td(tr, (a.pitch || "—").slice(0, 80), "adm-text"); td(tr, a.total == null ? "—" : Number(a.total).toFixed(2), "num");
      const act = actTd(tr);
      act.append(btn("Approve", async () => { if (sure("Approve this claim?")) okMsg(await post("/api/admin/seats/decide", { id: a.id, decision: "approve" }), "Claim approved"); }));
      act.append(btn("Reject", async () => { if (sure("Reject this claim? The applicant is removed from the window.")) okMsg(await post("/api/admin/seats/decide", { id: a.id, decision: "reject" }), "Claim rejected"); }));
    });
  const reportsTable = (reports) => table(
    ["Post", "Author", "Reports", "Last report", ""],
    reports,
    (tr, x) => {
      td(tr, (x.body || "").slice(0, 90), "adm-text"); td(tr, x.handle || x.name || "—"); td(tr, x.reports, "num"); td(tr, ago(x.last_report));
      const act = actTd(tr);
      act.append(btn("Hide", async () => { if (sure("Hide this post for good?")) okMsg(await post("/api/admin/reports/decide", { id: x.post_id, action: "hide" }), "Post hidden"); }));
      act.append(btn("Dismiss", async () => { if (sure("Dismiss all reports on this post?")) okMsg(await post("/api/admin/reports/decide", { id: x.post_id, action: "dismiss" }), "Report dismissed"); }));
    });
  // the reasons the rules know (src/policy.js moderation.reasons), in plain words: the same words the founder reads on their dashboard
  // (public/dashboard.js REASON_WORDS); the founder sees the reason and the note
  const PICTURE_REASONS = [["scam", "Scam or impersonation"], ["abuse", "Abuse or hate"], ["illegal", "Illegal"], ["spam", "Spam"], ["off_topic", "Not about the city"], ["other", "Breaks the rules"]];
  const PICTURE_STATE = { pending: "Waiting", approved: "Approved", rejected: "Not approved" };
  const kb = (n) => (n == null ? "—" : `${Math.max(1, Math.round(Number(n) / 1024))} KB`);
  /**
   * Coin pictures: the preview goes through /api/media, which serves a waiting picture to the staff and its founder only. The actions
   * cell holds the reason and the note on their own line and the two buttons under them, so it wraps instead of widening the table.
   */
  const picturesTable = (logos) => table(
    ["Picture", "City", "Founder", "File", "Uploaded", "State", ""],
    logos,
    (tr, x) => {
      const pic = el("td", "adm-pic");
      const cityName = x.city ? x.city.name : "—", founder = x.founder ? (x.founder.handle ? `@${x.founder.handle}` : x.founder.wallet || "—") : "—";
      // the picture is what the reviewer looks at, so it has a name (plain words: nothing here says it is approved)
      if (/^\/api\/media\/\d+$/.test(String(x.preview || ""))) { const img = el("img", "adm-thumb"); img.src = x.preview; img.alt = `Picture sent for ${cityName} by ${founder}`; img.width = 48; img.height = 48; img.loading = "lazy"; pic.append(img); }
      else pic.textContent = "—";
      tr.append(pic);
      td(tr, `${cityName}${x.city && x.city.country ? ` (${x.city.country})` : ""}${x.launched ? " · live" : ""}`);
      td(tr, founder);
      td(tr, `${String(x.type || "").replace("image/", "") || "?"} · ${kb(x.size)}`);
      td(tr, x.uploadedAt ? ago(x.uploadedAt) : "—");
      const state = PICTURE_STATE[x.status] || x.status || "—";
      // a replacement that waits or was refused while an earlier approved picture is still the public one says so
      td(tr, `${x.status === "rejected" && x.reason ? `${state}: ${(PICTURE_REASONS.find(([k]) => k === x.reason) || [])[1] || x.reason}` : state}${x.approved && !x.current ? " · an earlier approved picture still shows" : ""}`, "adm-text");
      const act = actTd(tr); act.classList.add("adm-act--pic");
      if (!can(2)) { act.append(el("span", "muted", "admin only")); return; }
      if (x.status === "approved" && x.current) { act.append(el("span", "muted", "Shown to everyone")); return; }
      const reason = el("select", "adm-pic__reason"); reason.setAttribute("aria-label", "Reason");
      for (const [k, label] of PICTURE_REASONS) { const o = el("option", null, label); o.value = k; reason.append(o); }
      const note = textInput("Note for the founder (3 to 300 characters)"); note.maxLength = 300; note.className = "adm-pic__note"; note.setAttribute("aria-label", "Note for the founder");
      const city = x.city ? x.city.id : null, mediaId = x.mediaId;
      const form = el("div", "adm-pic__reject"); form.append(reason, note); act.append(form);
      act.append(btn("Approve", async () => { if (sure("Approve this picture? Everyone will see it on the coin from now on.")) okMsg(await post("/api/admin/logos/decide", { city, mediaId, action: "approve" }), "Picture approved"); }));
      act.append(btn("Reject", async () => {
        if (note.value.trim().length < 3) { toast("Write a short note for the founder first (at least 3 characters)."); return; }
        if (sure("Reject this picture? The founder sees the reason and your note; nobody else sees the picture.")) okMsg(await post("/api/admin/logos/decide", { city, mediaId, action: "reject", reason: reason.value, note: note.value.trim() }), "Picture rejected");
      }));
    });
  /**
   * City-coin reviews (src/coinreview.js): each request as a card. The reviewer sees exactly the version the founder sent (its hash, the
   * picture next to the current one, what changes), the checks the server ran (and what the screening flagged), the founder's why; admins
   * approve that exact version (its hash is sent back and checked) or ask for changes with a reason the founder reads and an optional note
   * only they see. Approved tickers waiting for the city list show the line to add to scripts/cities/ticker-overrides.json.
   */
  const COIN_FIELD = { picture: "Picture", ticker: "Ticker", name: "Coin name", description: "Description" };
  function coinReviewsList(d) {
    const wrap = el("div", "adm-coinrev");
    const reviews = (d && d.reviews) || [], reasons = (d && d.reasons) || [];
    if (d && d.waitingRegistry && d.waitingRegistry.length) {
      const w = el("section", "card adm-coinrev__registry");
      w.append(el("h3", "adm-h3", "Waiting for the city list"), el("p", "small muted", "Approved ticker changes: add each line to scripts/cities/ticker-overrides.json in a pull request; the founder's launch waits until that update is deployed."));
      for (const x of d.waitingRegistry) w.append(el("p", "mono small", `${x.city && x.city.name ? x.city.name : ""} · ${JSON.stringify(x.registryPatch)}`));
      wrap.append(w);
    }
    if (!reviews.length) { wrap.append(el("p", "empty adm-empty", "Nothing here.")); return wrap; }
    for (const x of reviews) wrap.append(coinReviewCard(x, reasons));
    return wrap;
  }
  function coinReviewCard(x, reasons) {
    const card = el("article", `card adm-coinrev__item is-${x.status}`);
    const city = x.city ? [x.city.name, x.city.region, x.city.countryName].filter(Boolean).join(" · ") : "—";
    const head = el("div", "adm-coinrev__head");
    head.append(el("h3", "adm-h3", `${x.kind === "description" ? "Description" : "Change"} · ${city}`), el("span", `tag ${x.status === "pending" ? "tag--warn" : x.status === "approved" ? "tag--ok" : ""}`, x.label || x.status));
    card.append(head);
    const who = x.founder ? (x.founder.handle ? `@${x.founder.handle}` : x.founder.wallet || "—") : "—";
    card.append(el("p", "small muted", `${who}${x.founder && x.founder.handle && x.founder.wallet ? ` · ${x.founder.wallet}` : ""} · ${x.status === "pending" ? `waiting ${ago(x.submittedAt)}` : `decided ${ago(x.decidedAt)}`}`));
    const ver = el("p", "small adm-coinrev__version");
    ver.append(el("span", null, `Version ${x.version || "—"} `), el("code", "mono adm-coinrev__hash", x.contentHash || ""));
    card.append(ver);
    // what changes: now and proposed, pictures side by side
    const t = el("table", "admin-table adm-coinrev__diff");
    const hr = el("tr"); for (const h of ["", "Now", "Proposed"]) { const th = el("th", null, h); th.scope = "col"; hr.append(th); }
    const thead = el("thead"); thead.append(hr); t.append(thead);
    const tb = el("tbody");
    for (const r of x.diff || []) {
      const tr = el("tr");
      const th = el("th", null, COIN_FIELD[r.field] || r.field); th.scope = "row"; tr.append(th);
      for (const [v, which] of [[r.from, "now"], [r.to, "proposed"]]) {
        const c = el("td", "adm-text");
        if (r.field === "picture" && v) { const img = el("img", "adm-thumb"); img.src = v; img.width = 64; img.height = 64; img.alt = `${which === "now" ? "Current" : "Proposed"} picture of ${x.city ? x.city.name : "the city"}'s coin`; c.append(img); }
        else c.textContent = v == null ? "—" : String(v);
        tr.append(c);
      }
      tb.append(tr);
    }
    t.append(tb); card.append(t);
    if (x.why) card.append(el("p", "small", `The founder's why: ${x.why}`));
    // the checks the server ran
    if (x.checks && x.checks.length) {
      const ul = el("ul", "small adm-coinrev__checks");
      for (const c of x.checks) {
        const li = el("li", c.ok ? "is-ok" : "is-flag", `${c.ok ? "✓" : "!"} ${c.text}`);
        for (const i of c.issues || []) li.append(el("span", "adm-coinrev__issue", ` ${i.message || i.code}`));
        ul.append(li);
      }
      card.append(ul);
    }
    if (x.decision && x.decision.reason) card.append(el("p", "small", `Reason: ${x.decision.reason}${x.decision.note ? ` · Note to the founder: ${x.decision.note}` : ""}`));
    if (x.registryPatch) card.append(el("p", "small mono", `Add to scripts/cities/ticker-overrides.json: ${JSON.stringify(x.registryPatch)}`));
    if (x.status !== "pending") return card;
    const act = el("div", "adm-coinrev__act");
    if (!can(2)) { act.append(el("span", "muted", "admin only")); card.append(act); return card; }
    const reason = el("select", "adm-pic__reason"); reason.setAttribute("aria-label", "Reason the founder reads");
    for (const r of reasons) { const o = el("option", null, r.text); o.value = r.code; reason.append(o); }
    const note = textInput("Note for the founder (optional, 3 to 300 characters)"); note.maxLength = 300; note.className = "adm-pic__note"; note.setAttribute("aria-label", "Note for the founder");
    const form = el("div", "adm-pic__reject"); form.append(reason, note); act.append(form);
    act.append(btn("Approve this version", async () => {
      if (sure(`Approve version ${x.version} exactly as shown? ${x.kind === "description" ? "Its description" : "Its picture, ticker and name"} become the coin's (the launch still needs the owner's approval on the blockchain).`)) {
        okMsg(await post("/api/admin/coins/reviews/decide", { id: x.id, action: "approve", contentHash: x.contentHash }), "Approved");
      }
    }));
    act.append(btn("Ask for changes", async () => {
      const n = note.value.trim();
      if (n && n.length < 3) { toast("A note is 3 to 300 characters (or none)."); return; }
      if (sure("Ask the founder for changes? They see the reason, and your note if you wrote one; the coin stays as it was.")) {
        okMsg(await post("/api/admin/coins/reviews/decide", { id: x.id, action: "changes_needed", contentHash: x.contentHash, reasonCode: reason.value, ...(n ? { note: n } : {}) }), "Changes asked for");
      }
    }));
    card.append(act);
    return card;
  }
  const appealsTable = (appeals) => table(
    ["From", "Text", "When", ""],
    appeals,
    (tr, x) => {
      td(tr, x.handle || x.name || "—"); td(tr, (x.text || "").slice(0, 90), "adm-text"); td(tr, ago(x.created_at));
      const act = actTd(tr);
      if (can(2)) {
        act.append(btn("Uphold (lift ban)", async () => { if (sure("Uphold this appeal? The ban is lifted.")) okMsg(await post("/api/admin/appeals/decide", { id: x.id, decision: "uphold" }), "Appeal upheld"); }));
        act.append(btn("Reject", async () => { if (sure("Reject this appeal? The ban stays.")) okMsg(await post("/api/admin/appeals/decide", { id: x.id, decision: "reject" }), "Appeal rejected"); }));
      } else act.append(el("span", "muted", "admin only"));
    });
  const objectionsTable = (objections) => table(
    ["Seat", "Objector", "Reason", "When", ""],
    objections,
    (tr, x) => {
      td(tr, `${x.city_name} (${x.country}) — ${x.seat_status}`); td(tr, x.handle || x.name || "—");
      td(tr, (x.reason || "").slice(0, 90), "adm-text"); td(tr, ago(x.created_at));
      const act = actTd(tr);
      if (can(2)) {
        act.append(btn("Uphold", async () => { if (sure("Uphold this objection? The founder seat is revoked at once.")) okMsg(await post("/api/admin/objections/decide", { id: x.id, uphold: true }), "Objection upheld"); }));
        act.append(btn("Dismiss", async () => { if (sure("Dismiss this objection?")) okMsg(await post("/api/admin/objections/decide", { id: x.id, uphold: false }), "Objection dismissed"); }));
      } else act.append(el("span", "muted", "admin only"));
    });

  /* ---------- tab: users (the top bar's search asks the server: /api/admin/users?q=) ---------- */
  async function tabUsers(p) {
    p.append(intro(can(2) ? "Every account, newest first. Search by wallet, username or name in the bar above (at least 2 characters)." : "Every account, newest first. Search by username in the bar above (at least 2 characters); wallets are masked for moderators."));
    const list = el("div"); p.append(list);
    let ctl = null, seq = 0;
    async function load(q = "") {
      const mine = ++seq;
      if (ctl) ctl.abort();
      ctl = typeof AbortController === "function" ? new AbortController() : null; // the previous search is cancelled, not just ignored
      const d = await getAbortable(`/api/admin/users?q=${encodeURIComponent(q)}&limit=100`, ctl ? ctl.signal : undefined);
      if (mine !== seq || d.error === "aborted") return;
      count.textContent = q && d.ok ? `${d.users.length}${d.users.length >= 100 ? "+" : ""} found` : "";
      list.replaceChildren(!d.ok ? el("p", null, "Couldn't load users.") : table(
        ["User", "Wallet", "Home", "Joined", "Ban", ""],
        d.users,
        (tr, u) => {
          td(tr, u.handle || u.name || "—"); monoTd(tr, walletOf(u.wallet));
          td(tr, u.home_name ? `${u.home_name}, ${u.home_country || ""}` : "—");
          td(tr, u.created_at ? ago(u.created_at) : "—");
          td(tr, u.banned ? "banned" : "—");
          const act = actTd(tr);
          const who = u.wallet ? { wallet: u.wallet } : { userId: u.id }; // a member without a wallet is named by id
          if (can(2) && u.banned) act.append(btn("Unban", async () => { if (sure("Lift this ban?")) okMsg(await post("/api/admin/users/unban", who), "Unbanned"); }));
          if (can(2) && !u.banned) act.append(btn("Ban", async () => {
            const reason = prompt(`Ban ${u.handle || "this user"} for 30 days? Reason:`, "spam");
            if (reason === null || !reason.trim()) return; // Cancel (or an empty reason) bans nobody
            okMsg(await post("/api/admin/users/ban", { ...who, reason: reason.trim() }), "Banned");
          }));
        }));
    }
    const term = (v) => { const q = String(v || "").trim(); return q.length >= 2 ? q : ""; };
    usersQuery = (v) => { const q = String(v || "").trim(); if (q.length === 1) return; load(term(q)); };
    await load(term(search.value));
  }

  /* ---------- tab: seats (claims are in Moderation) ---------- */
  async function tabSeats(p) {
    p.append(intro("Every founder seat and where it stands. Open claims are in Moderation."));
    const row = el("div", "admin-row");
    const sel = el("select"); ["", "active", "provisional", "steward", "grace", "revoked", "released"].forEach((s) => {
      const o = el("option", null, s || "all statuses"); o.value = s; sel.append(o);
    });
    sel.addEventListener("change", () => load()); // filters as it changes, like the search box (no separate Filter button)
    row.append(field("Status", sel));
    p.append(row);
    const list = el("div"); p.append(list);
    async function load() {
      const d = await api(`/api/admin/seats?status=${encodeURIComponent(sel.value)}`);
      list.replaceChildren(!d.ok ? el("p", null, "Couldn't load seats.") : table(
        ["City", "Founder", "Status", "Since", "Ended"],
        d.seats,
        (tr, s) => {
          td(tr, `${s.city_name} (${s.country})`); td(tr, s.handle || walletOf(s.wallet)); td(tr, s.status);
          td(tr, s.activated_at ? ago(s.activated_at) : ago(s.created_at)); td(tr, s.ended_at ? `${ago(s.ended_at)} (${s.end_reason || ""})` : "—");
        }));
    }
    await load();
  }

  /* ---------- tab: elections ---------- */
  async function tabElections(p) {
    const d = await api("/api/admin/elections");
    p.append(!d.ok ? el("p", null, "Couldn't load elections.") : table(
      ["Country", "Status", "Opens", "Closes", "Votes"],
      d.elections,
      (tr, e) => { td(tr, e.country); td(tr, e.status); td(tr, ago(e.opened_at)); td(tr, ago(e.closes_at)); td(tr, e.votes, "num"); }));
    if (can(2)) {
      p.append(h2("New election"));
      const row = el("div", "admin-row");
      const country = textInput("US"); const seats = textInput("3"); const days = textInput("14");
      row.append(field("Country (2-letter)", country), field("Seats", seats), field("Days open", days),
        btn("Create", async () => okMsg(await post("/api/admin/elections/create", { country: country.value, seats: seats.value, closesInDays: days.value }), "Election created"), false));
      p.append(row);
    }
  }

  /* ---------- tab: tokens ---------- */
  async function tabTokens(p) {
    const d = await api("/api/admin/tokens");
    if (!d.ok) return p.replaceChildren(el("p", null, "Couldn't load tokens."));
    p.append(h2("Registered by admin"));
    p.append(table(["City", "Mint", "Platform", "Founder", "When"], d.registered, (tr, t) => {
      td(tr, t.city); monoTd(tr, short(t.mint)); td(tr, t.platform); monoTd(tr, t.founder_wallet ? short(t.founder_wallet) : "—"); td(tr, ago(t.created_at));
    }));
    p.append(h2("City coins launched on site"));
    p.append(table(["Coin", "City", "Mint", "Launched"], d.cityCoins, (tr, c) => {
      td(tr, c.name); td(tr, `${c.city_name} (${c.country})`); monoTd(tr, short(c.mint)); td(tr, c.launched_at ? ago(c.launched_at) : "—");
    }));
    if (can(2)) {
      p.append(h2("Register a token"));
      const row = el("div", "admin-row");
      const mint = textInput("Mint address"); const city = textInput("City name"); const fw = textInput("Founder wallet (optional)");
      const plat = el("select"); ["raydium", "launchlab", "jupiter", "other"].forEach((x) => { const o = el("option", null, x); o.value = x; plat.append(o); });
      row.append(field("Mint", mint), field("City", city), field("Founder wallet", fw), field("Platform", plat),
        btn("Register", async () => okMsg(await post("/api/admin/tokens/register", { mint: mint.value, city: city.value, founderWallet: fw.value || null, platform: plat.value }), "Token registered"), false));
      p.append(row);
    }
  }

  /* ---------- tab: snapshots ---------- */
  async function tabSnapshots(p) {
    const d = await api("/api/admin/snapshots");
    p.append(!d.ok ? el("p", null, "Couldn't load snapshots.") : table(
      ["Cutoff", "Status", "Holders", "Created", "Note"],
      d.snapshots,
      (tr, s) => { td(tr, ago(s.cutoff_at)); td(tr, s.status); td(tr, s.holders, "num"); td(tr, ago(s.created_at)); td(tr, (s.note || "").slice(0, 80), "adm-text"); }));
    if (can(3)) {
      p.append(h2("New snapshot"));
      const row = el("div", "admin-row");
      const cutoff = textInput("2026-10-01T00:00:00Z");
      row.append(field("Cutoff (ISO, past)", cutoff),
        btn("Create", async () => okMsg(await post("/api/admin/snapshots/create", { cutoff: cutoff.value }), "Snapshot created"), false));
      p.append(row);
      p.append(el("p", "muted small", "Creates the snapshot row; holder data is computed by the site's own job."));
    }
  }

  /* ---------- tab: config ---------- */
  async function tabConfig(p) {
    const d = config && config.ok ? config : await api("/api/admin/config");
    if (!d.ok) return p.replaceChildren(el("p", null, "Couldn't load config."));
    p.append(table(["Setting", "Value"], [
      ["Site mode", d.siteMode], ["Policy version", `v${d.policyVersion}`],
      ["Granted roles", d.grantedRoles], ["Audit rows", d.auditRows],
    ], (tr, [k, v]) => { td(tr, k); td(tr, v); }));
    p.append(h2("Secrets & settings"));
    p.append(intro("Presence only: values never leave the server."));
    p.append(table(["Name", "Set"], Object.entries(d.flags), (tr, [k, v]) => {
      monoTd(tr, k); const c = td(tr, v ? "yes" : "no"); c.className = v ? "flag-on" : "flag-off";
    }));
  }

  /* ---------- tab: roles ---------- */
  async function tabRoles(p) {
    p.append(intro("Owner wallets come only from the ADMIN_WALLETS setting. Moderator and admin roles are granted here. You can't change your own."));
    const d = await api("/api/admin/roles");
    const all = [...(d.envOwners || []), ...(d.roles || [])];
    p.append(!d.ok ? el("p", null, "Couldn't load roles.") : table(
      ["Wallet", "Role", "Source", "Granted by", ""],
      all,
      (tr, r) => {
        monoTd(tr, short(r.wallet)); td(tr, r.role); td(tr, r.source || "granted"); td(tr, r.granted_by ? short(r.granted_by) : "—");
        const act = actTd(tr);
        if (r.source !== "env" && r.wallet !== me.wallet) act.append(btn("Revoke", async () => { if (sure("Revoke this role?")) okMsg(await post("/api/admin/roles/revoke", { wallet: r.wallet }), "Role revoked"); }));
      }));
    p.append(h2("Grant a role"));
    const row = el("div", "admin-row");
    const wallet = textInput("Wallet address"); const role = el("select");
    ["moderator", "admin"].forEach((x) => { const o = el("option", null, x); o.value = x; role.append(o); });
    row.append(field("Wallet", wallet), field("Role", role),
      btn("Grant", async () => okMsg(await post("/api/admin/roles/grant", { wallet: wallet.value, role: role.value }), "Role granted"), false));
    p.append(row);
  }

  /* ---------- tab: audit ---------- */
  async function tabAudit(p) {
    p.append(intro("Every admin action, newest first. This log is never wiped by the test lab."));
    const d = await api("/api/admin/audit?limit=200");
    p.append(!d.ok ? el("p", null, "Couldn't load audit.") : table(
      ["When", "Actor", "Action", "Target", "Detail"],
      d.audit,
      (tr, a) => { td(tr, ago(a.created_at)); monoTd(tr, short(a.actor)); td(tr, a.action); td(tr, a.target, "mono adm-break"); td(tr, (a.detail || "").slice(0, 120), "adm-text"); }));
  }

  /* ---------- tab: test lab ---------- */
  async function tabTestlab(p) {
    p.append(intro("Seed clearly-marked test data (8 users, 3 seats, 5 posts, reports, an objection, an election), then wipe only that data. Real rows are never touched."));
    const row = el("div", "admin-row");
    row.append(btn("Seed test data", async () => okMsg(await post("/api/admin/test/seed", {}), "Test data seeded"), false));
    p.append(row);
    const dz = el("div", "card danger-zone");
    dz.append(el("h3", null, "Reset"));
    dz.append(el("p", "muted small", "Deletes ONLY rows seeded by the test lab. Type RESET to confirm."));
    const zrow = el("div", "admin-row");
    const confirm = textInput("RESET");
    zrow.append(field("Confirmation", confirm), btn("Wipe test data", async () => {
      if (confirm.value !== "RESET") return toast("Type RESET to confirm.");
      okMsg(await post("/api/admin/test/reset", { confirm: "RESET" }), "Test data wiped");
    }, false));
    dz.append(zrow);
    p.append(dz);
    p.append(h2("Preview the site as…"));
    p.append(el("p", "muted small", "Sets a cookie so you can walk through the site as a visitor, holder, founder or country manager without extra wallets."));
    const prow = el("div", "admin-row");
    const psel = el("select");
    [["", "normal (clear)"], ["visitor", "Visitor"], ["holder", "Holder"], ["founder", "Founder"], ["cm", "Country manager"]].forEach(([v, l]) => {
      const o = el("option", null, l); o.value = v; psel.append(o);
    });
    prow.append(field("Role preview", psel), btn("Apply", async () => {
      const r = await post("/api/admin/test/preview-role", { role: psel.value || null });
      okMsg(r, r.previewRole ? `Previewing as ${r.previewRole}` : "Preview cleared");
    }, false));
    p.append(prow);
  }

  /* ---------- go ---------- */
  $("#admin-sign").addEventListener("click", signIn);
  renderGate();
  loadMe(true);
})();
