// Admin dashboard: mission control for the founder. Needs site.js (window.V) and wallets.js (window.VW).
(() => {
  "use strict";
  const { $, $$, el, api, toast, short, ago } = window.V;
  const W = window.VW;
  const LVL = { moderator: 1, admin: 2, owner: 3 };
  const TABS = [
    ["overview", "Overview", 1], ["inbox", "Inbox", 1], ["users", "Users", 1], ["seats", "Seats", 1],
    ["elections", "Elections", 1], ["tokens", "Tokens", 1], ["content", "Content", 1],
    ["snapshots", "Snapshots", 1], ["config", "Config", 2], ["roles", "Roles", 3],
    ["audit", "Audit", 1], ["testlab", "Test lab", 3],
  ];
  let me = null, config = null, activeTab = "overview";
  let adapter = null, address = null, message = null;
  // the Inbox: how many messages are new (the badge on its tab and the browser title), refreshed every 20 seconds while the page is open
  const INBOX_POLL_MS = 20_000;
  let inboxNew = 0, inboxTimer = null;
  let inboxReload = null; // the Inbox tab's own reload while that tab is open: the poll calls it when the count moved, so the list is live too
  const baseTitle = document.title;

  const errBox = $("#admin-error");
  const setErr = (m) => { errBox.textContent = m || ""; errBox.hidden = !m; };
  const cancelled = (e) => /reject|cancel|denied|declin|closed/i.test(String(e?.message || e)) || e?.code === 4001;
  const can = (n) => me && LVL[me.role] >= n;

  /* ---------- sign-in ---------- */
  function renderGate() {
    const list = W.list();
    const box = $("#admin-wallets");
    if (list.length) {
      box.replaceChildren(...list.map((a) => {
        const b = el("button", "wallet-option"); b.type = "button";
        const icon = W.safeIcon(a.icon);
        if (icon) { const img = el("img"); img.alt = ""; img.src = icon; b.append(img); } else b.append(W.mark(a.name));
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

  async function loadMe() {
    const d = await api("/api/admin/me");
    if (!d.ok || !d.role) {
      setErr(d.ok ? "This wallet has no admin access. Ask the owner to grant it." : "Sign in first.");
      return;
    }
    me = d;
    $("#admin-gate").hidden = true;
    $("#admin-main").hidden = false;
    const badge = $("#admin-role");
    badge.textContent = me.role; badge.className = `role-badge ${me.role}`;
    $("#admin-who").textContent = short(me.wallet);
    config = await api("/api/admin/config").catch(() => null);
    if (config && config.ok && config.siteMode === "preview") $("#admin-banner").hidden = false;
    renderTabs();
    showTab("overview");
    startInboxPolling();
  }

  /* ---------- the Inbox badge: new messages, every 20 seconds while this page is open ---------- */
  function setInboxNew(n) {
    if (n === inboxNew) return;
    inboxNew = n;
    const badge = $("#inbox-badge");
    if (badge) { badge.textContent = String(n); badge.hidden = !n; badge.setAttribute("aria-label", `${n} new`); }
    document.title = n ? `(${n}) ${baseTitle}` : baseTitle;
  }
  async function pollInbox() {
    if (!me || document.visibilityState === "hidden") return; // a hidden tab asks again when it comes back
    const d = await api("/api/admin/feedback/count");
    if (!d || !d.ok) return;
    const n = Number(d.new) || 0, moved = n !== inboxNew;
    setInboxNew(n);
    if (moved && activeTab === "inbox" && inboxReload) inboxReload();
  }
  function startInboxPolling() {
    if (inboxTimer) return;
    pollInbox();
    inboxTimer = setInterval(pollInbox, INBOX_POLL_MS);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") pollInbox(); });
  }

  /* ---------- tabs ---------- */
  function renderTabs() {
    $("#admin-tabs").replaceChildren(...TABS.filter(([, , n]) => can(n)).map(([id, label]) => {
      const b = el("button", null, label); b.type = "button";
      if (id === "inbox") { const badge = el("span", "tab-badge", String(inboxNew)); badge.id = "inbox-badge"; badge.hidden = !inboxNew; badge.setAttribute("aria-label", `${inboxNew} new`); b.append(badge); }
      b.setAttribute("role", "tab"); b.setAttribute("aria-selected", id === activeTab ? "true" : "false");
      b.addEventListener("click", () => showTab(id));
      return b;
    }));
  }
  function showTab(id) {
    activeTab = id; renderTabs(); inboxReload = null;
    const p = $("#admin-panel"), loading = el("p", "muted", "Loading…"); p.replaceChildren(loading);
    ({ overview: tabOverview, inbox: tabInbox, users: tabUsers, seats: tabSeats, elections: tabElections, tokens: tabTokens,
       content: tabContent, snapshots: tabSnapshots, config: tabConfig, roles: tabRoles,
       audit: tabAudit, testlab: tabTestlab })[id](p).then(() => loading.remove()).catch((e) => p.replaceChildren(el("p", null, `Couldn't load: ${e.message}`)));
  }
  const h2 = (t) => el("h2", null, t);
  const refresh = () => showTab(activeTab);

  function table(headers, rows, renderRow) {
    const wrap = el("div", "table-wrap");
    const t = el("table", "holders__table");
    const thead = el("thead"); const hr = el("tr");
    headers.forEach((hh) => hr.append(el("th", null, hh)));
    thead.append(hr); t.append(thead);
    const tb = el("tbody");
    rows.forEach((r) => { const tr = el("tr"); renderRow(tr, r); tb.append(tr); });
    t.append(tb); wrap.append(t);
    if (!rows.length) wrap.append(el("p", "muted", "Nothing here."));
    return wrap;
  }
  const td = (tr, text, cls) => { const c = el("td", cls || null, text == null ? "—" : String(text)); tr.append(c); return c; };
  const monoTd = (tr, text) => td(tr, text, "mono");
  /** Ask before anything that cannot be undone with one click. */
  const sure = (msg) => window.confirm(msg);
  const btn = (label, fn, sm = true) => {
    const b = el("button", sm ? "btn btn--sm" : "btn btn--primary", label); b.type = "button";
    b.addEventListener("click", async () => { b.disabled = true; try { await fn(); } finally { b.disabled = false; } });
    return b;
  };
  const field = (label, input) => {
    const f = el("label", "field"); f.append(el("span", "fieldset__label", label), input); return f;
  };
  const textInput = (ph = "", value = "") => { const i = el("input"); i.placeholder = ph; i.value = value; return i; };
  const ERRORS = {
    reprove: "Confirm in your wallet, then try again.", not_in_preview: "Only available on the preview site.",
    own_objection: "You can't decide your own objection.", outranked: "You can't act on someone of equal or higher role.",
    protected_wallet: "That wallet is an owner wallet (ADMIN_WALLETS).", owner_not_grantable: "Owners come from ADMIN_WALLETS only.",
    window_closed: "That claim window is closed.",
  };
  const okMsg = (r, what) => { if (r && r.ok) { toast(`${what} ✓`); refresh(); } else toast(r && ERRORS[r.error] ? ERRORS[r.error] : `Failed: ${r && r.error ? r.error : "unknown"}`); };
  const walletOf = (w) => (w && w.includes("*") ? w : short(w));

  /* ---------- tab: overview ---------- */
  async function tabOverview(p) {
    const d = await api("/api/admin/overview");
    if (!d.ok) return p.replaceChildren(el("p", null, "Couldn't load overview."));
    p.append(h2("Overview"));
    const stats = [["Users", d.users], ["Open elections", d.openElections], ["Pending reports", d.pendingReports],
      ["Pending objections", d.pendingObjections], ["Registered tokens", d.registeredTokens],
      ["City coins live", d.launchedCityCoins], ["Snapshots", d.snapshots]];
    const g = el("div", "admin-grid");
    stats.forEach(([label, n]) => { const s = el("div", "stat"); s.append(el("b", null, String(n)), el("span", null, label)); g.append(s); });
    p.append(g);
    p.append(el("h3", null, "Seats by status"));
    const sg = el("div", "admin-grid");
    Object.entries(d.seats).forEach(([st, n]) => { const s = el("div", "stat"); s.append(el("b", null, String(n)), el("span", null, st)); sg.append(s); });
    p.append(sg);
  }

  /* ---------- tab: inbox (the Feedback / Support messages, src/feedback.js) ---------- */
  const KIND_LABEL = { question: "Question", bug: "Bug report", city: "City request" };
  const kindTag = (kind) => el("span", `inbox-kind inbox-kind--${kind}`, KIND_LABEL[kind] || kind);
  const fromOf = (x) => (x.handle ? `@${String(x.handle).replace(/^@/, "")}` : x.user_id ? `member #${x.user_id}` : "visitor (not signed in)");
  async function tabInbox(p) {
    p.append(h2("Inbox"));
    p.append(el("p", "muted", "Questions, bug reports and city requests sent with the Feedback button on every page, newest first. Open one to read it, mark it seen or done, copy the e-mail and leave a note for the team. The list refreshes by itself when a new message arrives."));
    const row = el("div", "admin-row");
    const status = el("select");
    [["open", "new & seen"], ["new", "new"], ["seen", "seen"], ["done", "done"], ["all", "all"]].forEach(([v, l]) => { const o = el("option", null, l); o.value = v; status.append(o); });
    const kind = el("select");
    [["", "all kinds"], ["question", "questions"], ["bug", "bug reports"], ["city", "city requests"]].forEach(([v, l]) => { const o = el("option", null, l); o.value = v; kind.append(o); });
    row.append(field("Status", status), field("Kind", kind), btn("Refresh", () => load()));
    p.append(row);
    const counts = el("p", "muted small"); counts.id = "inbox-counts"; p.append(counts);
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
        const act = el("td"); act.append(btn("Open", () => show(x, true))); tr.append(act);
      }));
      if (d.more) list.append(el("p", "muted small", "The newest 100 are shown; narrow the filters for older ones."));
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
      const box = el("div", "inbox-item"); box.id = "inbox-item";
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

  /* ---------- tab: users ---------- */
  async function tabUsers(p) {
    p.append(h2("Users"));
    const row = el("div", "admin-row");
    const search = textInput(can(2) ? "Search wallet, handle, name…" : "Search handle…");
    row.append(field("Search", search), btn("Search", () => load()));
    p.append(row);
    const list = el("div"); p.append(list);
    async function load() {
      const d = await api(`/api/admin/users?q=${encodeURIComponent(search.value)}&limit=100`);
      list.replaceChildren(!d.ok ? el("p", null, "Couldn't load users.") : table(
        ["User", "Wallet", "Home", "Joined", "Ban", ""],
        d.users,
        (tr, u) => {
          td(tr, u.handle || u.name || "—"); monoTd(tr, walletOf(u.wallet));
          td(tr, u.home_name ? `${u.home_name}, ${u.home_country || ""}` : "—");
          td(tr, u.created_at ? ago(u.created_at) : "—");
          td(tr, u.banned ? "banned" : "—");
          const act = el("td");
          if (can(2) && u.banned) act.append(btn("Unban", async () => { if (sure("Lift this ban?")) okMsg(await post("/api/admin/users/unban", { wallet: u.wallet }), "Unbanned"); }));
          if (can(2) && !u.banned) act.append(btn("Ban", async () => {
            const reason = prompt(`Ban ${u.handle || "this user"} for 30 days? Reason:`, "spam");
            if (reason === null || !reason.trim()) return; // Cancel (or an empty reason) bans nobody
            okMsg(await post("/api/admin/users/ban", { wallet: u.wallet, reason: reason.trim() }), "Banned");
          }));
          tr.append(act);
        }));
    }
    await load();
  }

  /* ---------- tab: seats ---------- */
  async function tabSeats(p) {
    p.append(h2("Founder seats"));
    const row = el("div", "admin-row");
    const sel = el("select"); ["", "active", "provisional", "steward", "grace", "revoked", "released"].forEach((s) => {
      const o = el("option", null, s || "all statuses"); o.value = s; sel.append(o);
    });
    row.append(field("Status", sel), btn("Filter", () => load()));
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
    if (can(2)) {
      p.append(h2("Open claims"));
      const c = await api("/api/admin/claims");
      p.append(!c.ok ? el("p", null, "Couldn't load claims.") : table(
        ["City", "Claimant", "Pitch", "Score", ""],
        c.claims,
        (tr, a) => {
          td(tr, `${a.city_name} (${a.country})`); td(tr, a.handle || walletOf(a.wallet));
          td(tr, (a.pitch || "—").slice(0, 80)); td(tr, a.total == null ? "—" : Number(a.total).toFixed(2));
          const act = el("td");
          act.append(btn("Approve", async () => { if (sure("Approve this claim?")) okMsg(await post("/api/admin/seats/decide", { id: a.id, decision: "approve" }), "Claim approved"); }));
          act.append(" ");
          act.append(btn("Reject", async () => { if (sure("Reject this claim? The applicant is removed from the window.")) okMsg(await post("/api/admin/seats/decide", { id: a.id, decision: "reject" }), "Claim rejected"); }));
          tr.append(act);
        }));
    }
  }

  /* ---------- tab: elections ---------- */
  async function tabElections(p) {
    p.append(h2("Elections"));
    const d = await api("/api/admin/elections");
    p.append(!d.ok ? el("p", null, "Couldn't load elections.") : table(
      ["Country", "Status", "Opens", "Closes", "Votes"],
      d.elections,
      (tr, e) => { td(tr, e.country); td(tr, e.status); td(tr, ago(e.opened_at)); td(tr, ago(e.closes_at)); td(tr, e.votes, "num"); }));
    if (can(2)) {
      p.append(el("h3", null, "New election"));
      const row = el("div", "admin-row");
      const country = textInput("US"); const seats = textInput("3"); const days = textInput("14");
      row.append(field("Country (2-letter)", country), field("Seats", seats), field("Days open", days),
        btn("Create", async () => okMsg(await post("/api/admin/elections/create", { country: country.value, seats: seats.value, closesInDays: days.value }), "Election created"), false));
      p.append(row);
    }
  }

  /* ---------- tab: tokens ---------- */
  async function tabTokens(p) {
    p.append(h2("Token registry"));
    const d = await api("/api/admin/tokens");
    if (!d.ok) return p.replaceChildren(el("p", null, "Couldn't load tokens."));
    p.append(el("h3", null, "Registered by admin"));
    p.append(table(["City", "Mint", "Platform", "Founder", "When"], d.registered, (tr, t) => {
      td(tr, t.city); monoTd(tr, short(t.mint)); td(tr, t.platform); monoTd(tr, t.founder_wallet ? short(t.founder_wallet) : "—"); td(tr, ago(t.created_at));
    }));
    p.append(el("h3", null, "City coins launched on site"));
    p.append(table(["Coin", "City", "Mint", "Launched"], d.cityCoins, (tr, c) => {
      td(tr, c.name); td(tr, `${c.city_name} (${c.country})`); monoTd(tr, short(c.mint)); td(tr, c.launched_at ? ago(c.launched_at) : "—");
    }));
    if (can(2)) {
      p.append(el("h3", null, "Register a token"));
      const row = el("div", "admin-row");
      const mint = textInput("Mint address"); const city = textInput("City name"); const fw = textInput("Founder wallet (optional)");
      const plat = el("select"); ["raydium", "launchlab", "jupiter", "other"].forEach((x) => { const o = el("option", null, x); o.value = x; plat.append(o); });
      row.append(field("Mint", mint), field("City", city), field("Founder wallet", fw), field("Platform", plat),
        btn("Register", async () => okMsg(await post("/api/admin/tokens/register", { mint: mint.value, city: city.value, founderWallet: fw.value || null, platform: plat.value }), "Token registered"), false));
      p.append(row);
    }
  }

  /* ---------- tab: content ---------- */
  async function tabContent(p) {
    p.append(h2("Reported posts"));
    const r = await api("/api/admin/reports");
    p.append(!r.ok ? el("p", null, "Couldn't load reports.") : table(
      ["Post", "Author", "Reports", "Last report", ""],
      r.reports,
      (tr, x) => {
        td(tr, (x.body || "").slice(0, 90)); td(tr, x.handle || x.name || "—"); td(tr, x.reports, "num"); td(tr, ago(x.last_report));
        const act = el("td");
        act.append(btn("Hide", async () => { if (sure("Hide this post for good?")) okMsg(await post("/api/admin/reports/decide", { id: x.post_id, action: "hide" }), "Post hidden"); }));
        act.append(" ");
        act.append(btn("Dismiss", async () => { if (sure("Dismiss all reports on this post?")) okMsg(await post("/api/admin/reports/decide", { id: x.post_id, action: "dismiss" }), "Report dismissed"); }));
        tr.append(act);
      }));
    p.append(h2("Ban appeals"));
    const a = await api("/api/admin/appeals");
    p.append(!a.ok ? el("p", null, "Couldn't load appeals.") : table(
      ["From", "Text", "When", ""],
      a.appeals,
      (tr, x) => {
        td(tr, x.handle || x.name || "—"); td(tr, (x.text || "").slice(0, 90)); td(tr, ago(x.created_at));
        const act = el("td");
        if (can(2)) {
          act.append(btn("Uphold (lift ban)", async () => { if (sure("Uphold this appeal? The ban is lifted.")) okMsg(await post("/api/admin/appeals/decide", { id: x.id, decision: "uphold" }), "Appeal upheld"); }));
          act.append(" ");
          act.append(btn("Reject", async () => { if (sure("Reject this appeal? The ban stays.")) okMsg(await post("/api/admin/appeals/decide", { id: x.id, decision: "reject" }), "Appeal rejected"); }));
        } else act.append(el("span", "muted", "admin only"));
        tr.append(act);
      }));
    p.append(h2("Seat objections"));
    const o = await api("/api/admin/objections");
    p.append(!o.ok ? el("p", null, "Couldn't load objections.") : table(
      ["Seat", "Objector", "Reason", "When", ""],
      o.objections,
      (tr, x) => {
        td(tr, `${x.city_name} (${x.country}) — ${x.seat_status}`); td(tr, x.handle || x.name || "—");
        td(tr, (x.reason || "").slice(0, 90)); td(tr, ago(x.created_at));
        const act = el("td");
        if (can(2)) {
          act.append(btn("Uphold", async () => { if (sure("Uphold this objection? The founder seat is revoked at once.")) okMsg(await post("/api/admin/objections/decide", { id: x.id, uphold: true }), "Objection upheld"); }));
          act.append(" ");
          act.append(btn("Dismiss", async () => { if (sure("Dismiss this objection?")) okMsg(await post("/api/admin/objections/decide", { id: x.id, uphold: false }), "Objection dismissed"); }));
        } else act.append(el("span", "muted", "admin only"));
        tr.append(act);
      }));
  }

  /* ---------- tab: snapshots ---------- */
  async function tabSnapshots(p) {
    p.append(h2("Snapshots"));
    const d = await api("/api/admin/snapshots");
    p.append(!d.ok ? el("p", null, "Couldn't load snapshots.") : table(
      ["Cutoff", "Status", "Holders", "Created", "Note"],
      d.snapshots,
      (tr, s) => { td(tr, ago(s.cutoff_at)); td(tr, s.status); td(tr, s.holders, "num"); td(tr, ago(s.created_at)); td(tr, (s.note || "").slice(0, 80)); }));
    if (can(3)) {
      p.append(el("h3", null, "New snapshot"));
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
    p.append(h2("Config"));
    p.append(table(["Setting", "Value"], [
      ["Site mode", d.siteMode], ["Policy version", `v${d.policyVersion}`],
      ["Granted roles", d.grantedRoles], ["Audit rows", d.auditRows],
    ], (tr, [k, v]) => { td(tr, k); td(tr, v); }));
    p.append(el("h3", null, "Secrets & settings (presence only — values never leave the server)"));
    p.append(table(["Name", "Set"], Object.entries(d.flags), (tr, [k, v]) => {
      td(tr, k); const c = td(tr, v ? "yes" : "no"); c.className = v ? "flag-on" : "flag-off";
    }));
  }

  /* ---------- tab: roles ---------- */
  async function tabRoles(p) {
    p.append(h2("Roles"));
    p.append(el("p", "muted", "Owner wallets come only from the ADMIN_WALLETS setting. Moderator and admin roles are granted here. You can't change your own."));
    const d = await api("/api/admin/roles");
    const all = [...d.envOwners, ...(d.roles || [])];
    p.append(!d.ok ? el("p", null, "Couldn't load roles.") : table(
      ["Wallet", "Role", "Source", "Granted by", ""],
      all,
      (tr, r) => {
        monoTd(tr, short(r.wallet)); td(tr, r.role); td(tr, r.source || "granted"); td(tr, r.granted_by ? short(r.granted_by) : "—");
        const act = el("td");
        if (r.source !== "env" && r.wallet !== me.wallet) act.append(btn("Revoke", async () => { if (sure("Revoke this role?")) okMsg(await post("/api/admin/roles/revoke", { wallet: r.wallet }), "Role revoked"); }));
        tr.append(act);
      }));
    p.append(el("h3", null, "Grant a role"));
    const row = el("div", "admin-row");
    const wallet = textInput("Wallet address"); const role = el("select");
    ["moderator", "admin"].forEach((x) => { const o = el("option", null, x); o.value = x; role.append(o); });
    row.append(field("Wallet", wallet), field("Role", role),
      btn("Grant", async () => okMsg(await post("/api/admin/roles/grant", { wallet: wallet.value, role: role.value }), "Role granted"), false));
    p.append(row);
  }

  /* ---------- tab: audit ---------- */
  async function tabAudit(p) {
    p.append(h2("Audit trail"));
    p.append(el("p", "muted", "Every admin action, newest first. This log is never wiped by the test lab."));
    const d = await api("/api/admin/audit?limit=200");
    p.append(!d.ok ? el("p", null, "Couldn't load audit.") : table(
      ["When", "Actor", "Action", "Target", "Detail"],
      d.audit,
      (tr, a) => { td(tr, ago(a.created_at)); monoTd(tr, short(a.actor)); td(tr, a.action); monoTd(tr, a.target); td(tr, (a.detail || "").slice(0, 120)); }));
  }

  /* ---------- tab: test lab ---------- */
  async function tabTestlab(p) {
    p.append(h2("Test lab"));
    p.append(el("p", "muted", "Seed clearly-marked test data (8 users, 3 seats, 5 posts, reports, an objection, an election), then wipe only that data. Real rows are never touched."));
    const row = el("div", "admin-row");
    row.append(btn("Seed test data", async () => okMsg(await post("/api/admin/test/seed", {}), "Test data seeded"), false));
    p.append(row);
    const dz = el("div", "danger-zone");
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
    p.append(el("h3", null, "Preview the site as…"));
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
  loadMe();
})();
