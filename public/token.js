// Token page: live token facts, every holder (the table scrolls, not the page), "where does this wallet stand?",
// the official token list and the link checker. Everything comes from this site's /api (read live from Solana).
(() => {
  "use strict";
  const { $, $$, el, api, toast, copy, fmt, compact, mask, isAddr } = window.V;
  const FOUNDER = 1_000_000;
  const pctText = (p) => (p >= 10 ? p.toFixed(1) : p >= 0.01 ? p.toFixed(2) : "<0.01");
  const usd = (n) => (n >= 1 ? "$" + n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "$" + n.toPrecision(3));
  let holders = [], launched = false;

  /* ---------- token facts ---------- */
  function renderRegistry(list) {
    const body = $("#registry-body"); if (!body || !Array.isArray(list)) return;
    body.replaceChildren(...list.map((t) => {
      const tr = el("tr");
      const ca = el("td");
      if (isAddr(t.contract)) ca.append(el("code", null, t.contract)); else ca.textContent = t.status === "Launching soon" ? "Launching soon" : "—";
      const st = el("td");
      st.append(el("span", t.contract ? "tag tag--ok" : t.status === "Launching soon" ? "tag tag--warn" : "tag", t.contract ? "Live" : t.status));
      tr.append(el("td", null, t.network), el("td", null, `${t.name} (${t.symbol.startsWith("e.g.") ? t.symbol : "$" + t.symbol})`), ca, st);
      return tr;
    }));
  }
  async function loadToken() {
    const d = await api("/api/token");
    renderRegistry(d.registry);
    launched = Boolean(d.launched);
    if (!d.launched || !d.facts) return;
    const f = d.facts, m = f.mint;
    $("#ca-text").textContent = m;
    $("#ca-copy").hidden = false;
    $("#ca-copy").onclick = () => copy(m, "Contract address copied");
    $("#lnk-solscan").href = `https://solscan.io/token/${m}`;
    $("#lnk-jup").href = `https://jup.ag/tokens/${m}`;
    $("#lnk-raydium").href = `https://raydium.io/launchpad/token/?mint=${m}`;
    $("#lnk-dex").href = `https://dexscreener.com/solana/${m}`;
    $("#ca-links").hidden = false;
    $("#ca-note").textContent = "This is the only official $VICINITY. Anything else using the name is fake.";
    const live = (key, ok, okText, badText) => $$(`[data-live="${key}"]`).forEach((e) => { e.textContent = ok ? okText : badText; e.classList.add(ok ? "is-live" : "is-bad"); });
    if (!f.mintingDisabled && f.mintHeldByProgram) $$('[data-live="mint"]').forEach((e) => { e.textContent = "Held by the launch program until the curve fills"; e.classList.add("is-wait"); });
    else live("mint", f.mintingDisabled, "Verified on-chain", "Warning: minting is ON");
    live("freeze", f.freezingDisabled, "Verified on-chain", "Warning: freezing is ON");
    live("supply", true, "Verified on-chain", "");
    live("supply2", true, "Verified on-chain", "");
    $("#supply-text").textContent = fmt(f.supply);
    $("#st-supply").textContent = compact(f.supply);
    if (d.price) { $("#st-price").textContent = usd(d.price); $("#st-mcap").textContent = d.marketCap ? `market cap ${"$" + compact(d.marketCap)}` : ""; }
    else { $("#st-price").textContent = "—"; $("#st-mcap").textContent = "price not available yet"; }
  }

  /* ---------- holders table ---------- */
  function row(h) {
    const tr = el("tr"); tr.dataset.owner = h.owner;
    const w = el("td");
    const a = el("a", null, mask(h.owner)); a.href = `https://solscan.io/account/${h.owner}`; a.target = "_blank"; a.rel = "noopener"; a.title = h.owner;
    w.append(a);
    if (h.label) w.append(el("span", "tag tag--ok", h.label));
    const max = holders[0]?.percent || 1;
    const pct = el("td", "num", `${pctText(h.percent)}%`);
    const bar = el("span", "pct-bar"), fill = el("span"); fill.style.width = `${Math.max(2, (h.percent / max) * 100)}%`; bar.append(fill); pct.append(bar);
    tr.append(el("td", null, h.rank ? String(h.rank) : "Pool"), w, el("td", "num", fmt(h.amount)), pct);
    return tr;
  }
  async function loadHolders() {
    const status = $("#holders-status");
    const d = await api("/api/holders");
    if (!d.launched) return;
    $("#holders-refresh").hidden = false;
    if (d.error || !Array.isArray(d.holders)) { status.textContent = "The blockchain is busy right now. Try Refresh in a minute."; return; }
    holders = d.holders;
    $("#holders-body").replaceChildren(...holders.map(row));
    const people = holders.filter((h) => h.rank);
    const total = d.total ?? people.length;
    status.textContent = d.full
      ? `${fmt(total)} holders · showing the top ${fmt(Math.min(holders.length, 1000))} · updated ${new Date(d.updatedAt).toLocaleTimeString()}`
      : `Top ${holders.length} wallets · updated ${new Date(d.updatedAt).toLocaleTimeString()}`;
    $("#st-holders").textContent = d.full ? fmt(total) : `${people.length}+`;
    $("#st-top10").textContent = `${pctText(people.slice(0, 10).reduce((s, h) => s + h.percent, 0))}%`;
    filter();
    if (lastLookup) mark(lastLookup, false);
  }
  function filter() {
    const q = $("#holders-find").value.trim();
    $$("#holders-body tr").forEach((tr) => { tr.hidden = Boolean(q) && !(tr.dataset.owner || "").includes(q); });
  }
  $("#holders-find").addEventListener("input", filter);
  $("#holders-refresh").addEventListener("click", loadHolders);

  /** Highlight a wallet's row and scroll the table (not the page) to it. */
  function mark(addr, scroll = true) {
    let found = null;
    $$("#holders-body tr").forEach((tr) => { const me = tr.dataset.owner === addr; tr.classList.toggle("is-me", me); if (me) found = tr; });
    if (found && scroll) { const box = $("#holders-scroll"); box.scrollTo({ top: found.offsetTop - box.clientHeight / 2, behavior: window.V.reduced ? "auto" : "smooth" }); }
    return found;
  }

  /* ---------- where does a wallet stand? ---------- */
  let lastLookup = null;
  async function lookup(addr) {
    if (!isAddr(addr)) { toast("That doesn't look like a Solana wallet address."); return; }
    const btn = $("#lookup button"); btn.disabled = true; btn.textContent = "Checking…";
    const d = await api(`/api/rank?address=${encodeURIComponent(addr)}`);
    btn.disabled = false; btn.textContent = "Check rank";
    $("#rank-empty").hidden = true; $("#rank-result").hidden = false;
    $("#rank-addr").textContent = addr;
    lastLookup = addr;
    const set = (id, t) => ($(id).textContent = t);
    if (d.error === "chain_unavailable") { set("#rank-num", "—"); set("#rank-of", ""); set("#rank-pct", "The blockchain is busy. Try again in a minute."); return; }
    if (!d.launched) {
      set("#rank-num", "—"); set("#rank-of", "");
      set("#rank-pct", "Ranks go live the moment $VICINITY launches. Save this page and check back.");
      ["#rank-amount", "#rank-share", "#rank-next", "#rank-founder"].forEach((i) => set(i, "At launch"));
      $("#rank-meter").style.width = "0%"; $("#rank-show").hidden = true;
      return;
    }
    const amount = d.amount || 0;
    set("#rank-amount", `${fmt(amount)} $VICINITY`);
    set("#rank-share", amount ? `${pctText(d.percent || 0)}%` : "0%");
    set("#rank-founder", amount >= FOUNDER ? "✓ Holds it (must hold 7 days)" : `${fmt(FOUNDER - amount)} to go`);
    if (d.label && !d.rank) { set("#rank-num", "Pool"); set("#rank-of", d.label); set("#rank-pct", "Pools and curves are listed but not ranked."); }
    else if (d.rank) {
      set("#rank-num", `#${fmt(d.rank)}`); set("#rank-of", `of ${fmt(d.total)} holders`);
      set("#rank-pct", d.rank === 1 ? "The biggest holder of all 🏆" : `Top ${pctText(d.percentile)}% of all holders`);
      set("#rank-next", d.next ? (d.rank === 1 ? "You're #1 🏆" : `${fmt(Math.ceil(d.next.gap))} to pass #${d.next.rank}`) : "—");
      requestAnimationFrame(() => ($("#rank-meter").style.width = `${Math.max(2, 100 - d.percentile)}%`));
    } else if (!d.full && amount > 0) {
      set("#rank-num", "—"); set("#rank-of", ""); set("#rank-pct", "Holds $VICINITY. The full ranking is loading; try again in a minute.");
    } else {
      set("#rank-num", "—"); set("#rank-of", "not holding yet");
      set("#rank-pct", "This wallet doesn't hold $VICINITY yet.");
      set("#rank-next", d.next ? `${fmt(Math.ceil(d.next.gap))} to enter at #${d.next.rank + 1}` : "Any amount");
      $("#rank-meter").style.width = "0%";
    }
    $("#rank-show").hidden = !mark(addr, false);
  }
  $("#lookup").addEventListener("submit", (e) => { e.preventDefault(); lookup($("#lookup-input").value.trim()); });
  $("#rank-show").addEventListener("click", () => { $("#holders").scrollIntoView({ behavior: window.V.reduced ? "auto" : "smooth" }); setTimeout(() => mark(lastLookup), 400); });

  /* ---------- official link checker ---------- */
  $("#checker").addEventListener("submit", async (e) => {
    e.preventDefault();
    const result = $("#check-result");
    const d = await api(`/api/check?q=${encodeURIComponent($("#check-input").value.trim())}`);
    if (!d.verdict) { result.className = "check-result check-result--unknown"; result.textContent = "Couldn't reach the checker. Please try again."; result.hidden = false; return; }
    const icon = { official: "✓", not_official: "✕", warning: "!", unknown: "?", empty: "?" }[d.verdict] || "?";
    const title = { official: "Official", not_official: "Not official", warning: "Be careful" }[d.verdict] || "Hmm";
    const body = el("div"); body.append(el("strong", null, title), el("p", null, d.message));
    result.className = `check-result check-result--${d.verdict}`;
    result.replaceChildren(el("span", "check-result__icon", icon), body); result.hidden = false;
  });

  loadToken();
  loadHolders();
  setInterval(() => { if (launched && !document.hidden) loadHolders(); }, 60_000);
  const q = new URLSearchParams(location.search).get("address");
  if (q) { $("#lookup-input").value = q; lookup(q); }
})();
