// Admin dashboard: mission control for the founder. Needs site.js (window.V) and wallets.js (window.VW).
(() => {
  "use strict";
  const { $, $$, el, api, toast, short, ago } = window.V;
  const W = window.VW;
  const LVL = { moderator: 1, admin: 2, owner: 3 };
  const TABS = [
    ["overview", "Overview", 1], ["users", "Users", 1], ["seats", "Seats", 1],
    ["elections", "Elections", 1], ["tokens", "Tokens", 1], ["content", "Content", 1],
    ["snapshots", "Snapshots", 1], ["config", "Config", 2], ["roles", "Roles", 3],
    ["audit", "Audit", 1], ["testlab", "Test lab", 3],
  ];
  let me = null, config = null, activeTab = "overview";
  let adapter = null, address = null, message = null;

  const errBox = $("#admin-error");
  const setErr = (m) => { errBox.textContent = m || ""; errBox.hidden = !m; };
  const cancelled = (e) => /reject|cancel|denied|declin|closed/i.test(String(e?.message || e)) || e?.code === 4001;
  const can = (n) => me && LVL[me.role] >= n;

  /* ---------- sign-in ---------- */
  function renderGate() {
    const list = W.list();
    $("#admin-wallets").replaceChildren(...list.map((a) => {
      const b = el("button", "wallet-option"); b.type = "button";
      const icon = W.safeIcon(a.icon);
      if (icon) { const img = el("img"); img.alt = ""; img.src = icon; b.append(img); } else b.append(W.mark(a.name));
      b.append(el("span", null, a.name), el("span", "detected", "Sign"));
      b.addEventListener("click", () => pickWallet(a));
      return b;
    }), list.length ? null : el("p", "muted", "No wallet detected. Install Phantom or another Solana wallet, then reload."));
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

  /** Re-prove the wallet for sensitive actions (fresh proof), then retry once. */
  async function sensitive(call) {
    let r = await call();
    if (r && r.error === "reprove") {
      try {
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
  }

  /* ---------- tabs ---------- */
  function renderTabs() {
    $("#admin-tabs").replaceChildren(...TABS.filter(([, , n]) => can(n)).map(([id, label]) => {
      const b = el("button", null, label); b.type = "button";
      b.setAttribute("role", "tab"); b.setAttribute("aria-selected", id === activeTab ? "true" : "false");
      b.addEventListener("click", () => showTab(id));
      return b;
    }));
  }
  function showTab(id) {
    activeTab = id; renderTabs();
    const p = $("#admin-panel"); p.replaceChildren(el("p", "muted", "Loading…"));
    ({ overview: tabOverview, users: tabUsers, seats: tabSeats, elections: tabElections, tokens: tabTokens,
       content: tabContent, snapshots: tabSnapshots, config: tabConfig, roles: tabRoles,
       audit: tabAudit, testlab: tabTestlab })[id](p).catch((e) => p.replaceChildren(el("p", null, `Couldn't load: ${e.message}`)));
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
  const btn = (label, fn, sm = true) => {
    const b = el("button", sm ? "btn btn--sm" : "btn btn--primary", label); b.type = "button";
    b.addEventListener("click", async () => { b.disabled = true; try { await fn(); } finally { b.disabled = false; } });
    return b;
  };
  const field = (label, input) => {
    const f = el("label", "field"); f.append(el("span", "fieldset__label", label), input); return f;
  };
  const textInput = (ph = "", value = "") => { const i = el("input"); i.placeholder = ph; i.value = value; return i; };
  const okMsg = (r, what) => { if (r && r.ok) { toast(`${what} ✓`); refresh(); } else toast(`Failed: ${r && r.error ? r.error : "unknown"}`); };

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

  /* ---------- tab: users ---------- */
  async function tabUsers(p) {
    p.append(h2("Users"));
    const row = el("div", "admin-row");
    const search = textInput("Search wallet, handle, name…");
    row.append(field("Search", search), btn("Search", () => load()));
    p.append(row);
    const list = el("div"); p.append(list);
    async function load() {
      const d = await api(`/api/admin/users?q=${encodeURIComponent(search.value)}&limit=100`);
      list.replaceChildren(!d.ok ? el("p", null, "Couldn't load users.") : table(
        ["User", "Wallet", "Home", "Joined", "Ban", ""],
        d.users,
        (tr, u) => {
          td(tr, u.handle || u.name || "—"); monoTd(tr, short(u.wallet));
          td(tr, u.home_name ? `${u.home_name}, ${u.home_country || ""}` : "—");
          td(tr, u.created_at ? ago(u.created_at) : "—");
          td(tr, u.banned ? "banned" : "—");
          const act = el("td");
          if (can(2) && u.banned) act.append(btn("Unban", async () => okMsg(await sensitive(() => api("/api/admin/users/unban", { wallet: u.wallet })), "Unbanned")));
          if (can(2) && !u.banned) act.append(btn("Ban", async () => {
            const reason = prompt("Ban reason:", "spam") || "spam";
            okMsg(await sensitive(() => api("/api/admin/users/ban", { wallet: u.wallet, reason })), "Banned");
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
          td(tr, `${s.city_name} (${s.country})`); td(tr, s.handle || short(s.wallet)); td(tr, s.status);
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
          td(tr, `${a.city_name} (${a.country})`); td(tr, a.handle || short(a.wallet));
          td(tr, (a.pitch || "—").slice(0, 80)); td(tr, a.total == null ? "—" : Number(a.total).toFixed(2));
          const act = el("td");
          act.append(btn("Approve", async () => okMsg(await api("/api/admin/seats/decide", { id: a.id, decision: "approve" }), "Claim approved")));
          act.append(" ");
          act.append(btn("Reject", async () => okMsg(await api("/api/admin/seats/decide", { id: a.id, decision: "reject" }), "Claim rejected")));
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
        btn("Create", async () => okMsg(await api("/api/admin/elections/create", { country: country.value, seats: seats.value, closesInDays: days.value }), "Election created"), false));
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
        btn("Register", async () => okMsg(await api("/api/admin/tokens/register", { mint: mint.value, city: city.value, founderWallet: fw.value || null, platform: plat.value }), "Token registered"), false));
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
        act.append(btn("Hide", async () => okMsg(await api("/api/admin/reports/decide", { id: x.post_id, action: "hide" }), "Post hidden")));
        act.append(" ");
        act.append(btn("Dismiss", async () => okMsg(await api("/api/admin/reports/decide", { id: x.post_id, action: "dismiss" }), "Report dismissed")));
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
          act.append(btn("Uphold (lift ban)", async () => okMsg(await api("/api/admin/appeals/decide", { id: x.id, decision: "uphold" }), "Appeal upheld")));
          act.append(" ");
          act.append(btn("Reject", async () => okMsg(await api("/api/admin/appeals/decide", { id: x.id, decision: "reject" }), "Appeal rejected")));
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
        act.append(btn("Uphold", async () => okMsg(await api("/api/admin/objections/decide", { id: x.id, uphold: true }), "Objection upheld")));
        act.append(" ");
        act.append(btn("Dismiss", async () => okMsg(await api("/api/admin/objections/decide", { id: x.id, uphold: false }), "Objection dismissed")));
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
    if (can(2)) {
      p.append(el("h3", null, "New snapshot"));
      const row = el("div", "admin-row");
      const cutoff = textInput("2026-10-01T00:00:00Z");
      row.append(field("Cutoff (ISO, past)", cutoff),
        btn("Create", async () => okMsg(await api("/api/admin/snapshots/create", { cutoff: cutoff.value }), "Snapshot created"), false));
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
    p.append(el("p", "muted", "Owner wallets come from the ADMIN_WALLETS setting. Extra roles are granted here. You can't change your own."));
    const d = await api("/api/admin/roles");
    const all = [...d.envOwners, ...(d.roles || [])];
    p.append(!d.ok ? el("p", null, "Couldn't load roles.") : table(
      ["Wallet", "Role", "Source", "Granted by", ""],
      all,
      (tr, r) => {
        monoTd(tr, short(r.wallet)); td(tr, r.role); td(tr, r.source || "granted"); td(tr, r.granted_by ? short(r.granted_by) : "—");
        const act = el("td");
        if (r.source !== "env" && r.wallet !== me.wallet) act.append(btn("Revoke", async () => okMsg(await sensitive(() => api("/api/admin/roles/revoke", { wallet: r.wallet })), "Role revoked")));
        tr.append(act);
      }));
    p.append(el("h3", null, "Grant a role"));
    const row = el("div", "admin-row");
    const wallet = textInput("Wallet address"); const role = el("select");
    ["moderator", "admin", "owner"].forEach((x) => { const o = el("option", null, x); o.value = x; role.append(o); });
    row.append(field("Wallet", wallet), field("Role", role),
      btn("Grant", async () => okMsg(await sensitive(() => api("/api/admin/roles/grant", { wallet: wallet.value, role: role.value })), "Role granted"), false));
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
    row.append(btn("Seed test data", async () => okMsg(await api("/api/admin/test/seed", {}), "Test data seeded"), false));
    p.append(row);
    const dz = el("div", "danger-zone");
    dz.append(el("h3", null, "Reset"));
    dz.append(el("p", "muted small", "Deletes ONLY rows seeded by the test lab. Type RESET to confirm."));
    const zrow = el("div", "admin-row");
    const confirm = textInput("RESET");
    zrow.append(field("Confirmation", confirm), btn("Wipe test data", async () => {
      if (confirm.value !== "RESET") return toast("Type RESET to confirm.");
      okMsg(await sensitive(() => api("/api/admin/test/reset", { confirm: "RESET" })), "Test data wiped");
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
      const r = await api("/api/admin/test/preview-role", { role: psel.value || null });
      okMsg(r, r.previewRole ? `Previewing as ${r.previewRole}` : "Preview cleared");
    }, false));
    p.append(prow);
  }

  /* ---------- go ---------- */
  $("#admin-sign").addEventListener("click", signIn);
  renderGate();
  loadMe();
})();
