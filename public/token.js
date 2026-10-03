// Token page: live token facts, every holder (the table scrolls, not the page; it is loaded in pages and drawn in chunks), "where does this wallet stand?",
// the official token list and the link checker. Everything comes from this site's /api (read live from Solana).
(() => {
  "use strict";
  const { $, $$, el, api, toast, copy, fmt, compact, mask, isAddr, official } = window.V;
  const FOUNDER_MAX = 1_000_000; // the top of the Stake Ladder (100K to 1M by city size, see /rules#ladder)
  const pctText = (p) => (p >= 10 ? p.toFixed(1) : p >= 0.01 ? p.toFixed(2) : "<0.01");
  const usd = (n) => (n >= 1 ? "$" + n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "$" + n.toPrecision(3));
  let holders = [], launched = false;

  /* ---------- token facts ---------- */
  function renderRegistry(list) {
    const body = $("#registry-body"); if (!body || !Array.isArray(list)) return;
    body.replaceChildren(...list.map((t) => {
      const tr = el("tr");
      const ca = el("td");
      if (isAddr(t.contract)) ca.append(el("code", null, t.contract)); else ca.textContent = t.status || "—";
      const st = el("td");
      st.append(el("span", t.contract ? "tag tag--ok" : /^launching/i.test(t.status || "") ? "tag tag--warn" : "tag", t.contract ? "Live" : t.status));
      tr.append(el("td", null, t.network), el("td", null, `${t.name} (${t.symbol.startsWith("e.g.") ? t.symbol : "$" + t.symbol})`), ca, st);
      return tr;
    }));
  }
  /** The official contract, its copy button and its trade links: from the chain's answer, or from the settings while the chain is busy. */
  function showContract(m) {
    $("#ca-text").textContent = m;
    $("#ca-copy").hidden = false;
    $("#ca-copy").onclick = () => copy(m, "Contract address copied");
    $("#lnk-solscan").href = `https://solscan.io/token/${m}`;
    $("#lnk-jup").href = `https://jup.ag/tokens/${m}`;
    $("#lnk-raydium").href = `https://raydium.io/launchpad/token/?mint=${m}`;
    $("#lnk-dex").href = `https://dexscreener.com/solana/${m}`;
    $("#ca-links").hidden = false;
    $("#ca-note").textContent = "This is the only official $VICINITY. Anything else using the name is fake.";
  }
  async function loadToken() {
    const d = await api("/api/token");
    renderRegistry(d.registry);
    launched = Boolean(d.launched);
    if (!d.launched) { // before the launch (VICINITY_MINT not set): say so, never a date or a guess
      $("#ca-text").textContent = "Not published yet";
      $("#ca-note").textContent = "Until it's published here, any \"$VICINITY\" you see is fake.";
      $$('[data-live="mint"], [data-live="freeze"], [data-live="supply2"]').forEach((e) => { e.textContent = "Checked live at launch"; });
      return;
    }
    const m = d.facts ? d.facts.mint : d.mint;
    if (isAddr(m)) showContract(m);
    if (!d.facts) { // the chain is busy: the contract is known, the live checks wait for the next visit
      $$('[data-live="mint"], [data-live="freeze"], [data-live="supply2"]').forEach((e) => { e.textContent = "The blockchain is busy: check again in a minute"; e.classList.add("is-wait"); });
      return;
    }
    const f = d.facts;
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
  /** "Team wallets public": say how many are actually listed (the official list is the one source), never just "Listed". */
  function renderTeamCount(o) {
    const e = $("#team-count"); if (!e) return;
    const n = o && Array.isArray(o.teamWallets) ? o.teamWallets.length : 0;
    e.textContent = n ? `${n} wallet${n === 1 ? "" : "s"} listed` : "No team wallets yet";
  }

  /* ---------- holders table ---------- */
  // The server answers 1,000 wallets at a time (/api/holders?offset=N, `more` says whether to ask again); the page keeps
  // asking until every holder is here. Rows go into the table 250 per animation frame, so a list of 10,000 wallets never
  // freezes the page. The box itself scrolls on its own and, once the live list is in it, has a fixed height (style.css
  // .holders--live .table-scroll), so the page stays the same length however many people hold the token.
  const CHUNK = 250, MAX_PAGES = 200;
  let queue = [], drawing = false, restart = false, loading = false, keepScroll = 0, load = 0, lastSnap = null;
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
  const query = () => $("#holders-find").value.trim();
  /** A row as it goes into the table: already filtered by the find box and highlighted if it is the wallet last looked up. */
  function place(h) {
    const tr = row(h), q = query();
    tr.hidden = Boolean(q) && !h.owner.includes(q);
    if (lastLookup && h.owner === lastLookup) { tr.classList.add("is-me"); $("#rank-show").hidden = false; } // its row can land after the lookup: the button follows it
    return tr;
  }
  /** After a refresh, put the reader back where they were: once the rows reach that far, or at the end of the load as far as they go. */
  function restore(final) {
    if (!keepScroll) return;
    const box = $("#holders-scroll");
    if (final || box.scrollHeight - box.clientHeight >= keepScroll) { box.scrollTop = keepScroll; keepScroll = 0; }
  }
  function draw() {
    const body = $("#holders-body"), rows = queue.splice(0, CHUNK).map(place);
    if (restart) { body.replaceChildren(...rows); restart = false; } else body.append(...rows); // a new load swaps the old rows for its first chunk: the table is never empty for a frame
    drawing = queue.length > 0;
    restore(!drawing && !loading);
    if (drawing) requestAnimationFrame(draw);
  }
  /** Queue rows for the table; `first` starts over (a new load) and remembers how far down the reader was. */
  function show(rows, first) {
    if (first) {
      queue = []; restart = true; loading = true;
      if (!keepScroll) keepScroll = $("#holders-scroll").scrollTop; // a second refresh before the first put the reader back keeps the older place
      $(".holders").classList.add("holders--live"); // from here on the box has its fixed height (style.css)
    }
    queue.push(...rows);
    if (!drawing && (queue.length || restart)) { drawing = true; requestAnimationFrame(draw); }
  }
  async function loadHolders() {
    const status = $("#holders-status");
    const run = ++load; // Refresh, or the minute timer, while pages are still coming: the older load stops where it is
    const d = await api("/api/holders");
    if (run !== load) return;
    if (!d.launched) { status.textContent = "The live holder list opens the moment $VICINITY launches."; return; }
    $("#holders-refresh").hidden = false;
    if (d.error || !Array.isArray(d.holders)) { status.textContent = "The blockchain is busy right now. Try Refresh in a minute."; return; }
    // the snapshot already on screen (the server keeps one for a minute): no more pages to ask for, nothing to redraw
    if (lastSnap && d.full && d.updatedAt === lastSnap.at && d.count === lastSnap.count) { status.textContent = lastSnap.text; return; }
    lastSnap = null;
    holders = d.holders;
    show(holders, true);
    // the next pages, if any; a wallet seen twice (the server's snapshot moved on between two pages) is listed once
    const seen = new Set(holders.map((h) => h.owner));
    let complete = true, offset = holders.length;
    for (let page = d, pages = 1; page.more && pages < MAX_PAGES; pages++) {
      status.textContent = `${fmt(holders.length)} of ${fmt(page.count)} loaded…`;
      page = await api(`/api/holders?offset=${offset}`);
      if (run !== load) return;
      if (page.error || !Array.isArray(page.holders) || !page.holders.length) { complete = false; break; }
      offset += page.holders.length;
      const fresh = page.holders.filter((h) => !seen.has(h.owner) && seen.add(h.owner));
      holders = holders.concat(fresh);
      show(fresh, false);
    }
    loading = false;
    if (!drawing) restore(true); // every row is drawn already; otherwise draw() does this when its queue runs out
    const people = holders.filter((h) => h.rank);
    const total = d.total ?? people.length;
    const at = new Date(d.updatedAt).toLocaleTimeString();
    status.textContent = !d.full ? `Top ${holders.length} wallets · updated ${at}`
      : complete ? `${fmt(total)} holders · updated ${at}`
      : `${fmt(total)} holders · showing the top ${fmt(people.length)} · updated ${at}`;
    if (complete && d.full) lastSnap = { at: d.updatedAt, count: d.count, text: status.textContent };
    $("#st-holders").textContent = d.full ? fmt(total) : `${people.length}+`;
    $("#st-top10").textContent = `${pctText(people.slice(0, 10).reduce((s, h) => s + h.percent, 0))}%`;
  }
  /** The find box: every row already in the table; rows still on their way are filtered as they are placed. */
  function filter() {
    const q = query();
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
    // every lookup starts from a blank card: nothing of the wallet looked up before may stay on it
    set("#rank-num", "—"); set("#rank-of", ""); set("#rank-pct", "");
    ["#rank-amount", "#rank-share", "#rank-next", "#rank-founder"].forEach((i) => set(i, "—"));
    $("#rank-meter").style.width = "0%";
    if (d.error === "chain_unavailable") { set("#rank-num", "—"); set("#rank-of", ""); set("#rank-pct", "The blockchain is busy. Try again in a minute."); return; }
    // many checks from one shared connection (an office, a campus, a mobile network): say so, never "not launched"
    if (d.error === "slow_down") { set("#rank-num", "—"); set("#rank-of", ""); set("#rank-pct", "Too many checks from your network. Try again in a minute."); return; }
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
    const founderMin = d.founderMin || 100_000; // the smallest founder amount: the exact one depends on the city
    set("#rank-founder", amount >= FOUNDER_MAX ? "✓ Enough for any city (hold it 7 days)"
      : amount >= founderMin ? "✓ Enough for smaller cities (hold it 7 days)" : `${fmt(founderMin - amount)} to reach the smallest`);
    if (d.label && !d.rank) { // a pool or curve: no rank, no wallet to pass, not a founder
      set("#rank-num", "Pool"); set("#rank-of", d.label); set("#rank-pct", "Pools and curves are listed but not ranked.");
      set("#rank-founder", "—");
    }
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
      // any amount above zero is ranked, right after the last ranked wallet (d.next); its whole amount is what passes it
      set("#rank-next", d.next ? `Any amount enters at #${fmt(d.next.rank + 1)}; ${fmt(Math.ceil(d.next.gap))} to pass #${fmt(d.next.rank)}` : "Any amount");
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
  if (official && official.then) official.then(renderTeamCount, () => renderTeamCount(null));
  setInterval(() => { if (launched && !document.hidden) loadHolders(); }, 60_000);
  const q = new URLSearchParams(location.search).get("address");
  if (q) { $("#lookup-input").value = q; lookup(q); }
})();
