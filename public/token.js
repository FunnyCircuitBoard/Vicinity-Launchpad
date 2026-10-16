// Token page: live token facts; one block with two tabs, Trades (the newest buys and sells, from the coin answer the page already reads)
// and Holders (every holder: the table scrolls, not the page; it is loaded in pages and drawn in chunks) with one box that finds a wallet in
// the list and checks where any wallet stands (the answer pops up over the page); the official token list, the link checker and the FAQ
// (old links to /token#buy open its "How do I get $VICINITY?"). Everything comes from this site's /api (read live from Solana).
(() => {
  "use strict";
  const { $, $$, el, api, copy, fmt, compact, mask, isAddr, official, ago } = window.V;
  const FOUNDER_MAX = 1_000_000; // the top of the Stake Ladder (100K to 1M by city size, see /rules#ladder)
  const pctText = (p) => (p >= 10 ? p.toFixed(1) : p >= 0.01 ? p.toFixed(2) : "<0.01");
  const usd = (n) => (n >= 1 ? "$" + n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "$" + n.toPrecision(3));
  /** A clock time in the reader's locale ("6:29 AM"), one format for both cards' "updated", "list from" and "as of"; "" when the time is unreadable. */
  const hhmm = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : ""; };
  /** A published team wallet (labelled "Team wallet (public)", or "Team wallet (FOMO)", by the server): shown and labelled, never ranked, like a pool. */
  const isTeam = (h) => !h.rank && /^Team wallet/.test(h.label || "");
  /** The team's locked tokens (labelled "Team lock (Jupiter Lock)" by the server): the same, and its tag opens the lock's page. */
  const isLock = (h) => !h.rank && /^Team lock/.test(h.label || "");
  let holders = [], launched = false;
  let lock; // the team lock of /api/official (teamLocks): undefined until it answers, null when it could not

  /* ---------- token facts ---------- */
  function renderRegistry(list) {
    const body = $("#registry-body"); if (!body || !Array.isArray(list)) return;
    body.replaceChildren(...list.map((t) => {
      const tr = el("tr");
      const ca = el("td");
      // the official contract is printed once on the page (the card at the top): the row points at it; a token without a contract shows a dash (its status is the tag)
      // a coin of the Vicinity Launchpad (one per city, each with its own contract) points at the Launchpad's live list instead
      if (isAddr(t.contract)) { const a = el("a", "registry__above", "Shown above ↑"); a.href = "#contract"; a.title = t.contract; ca.append(a); }
      else if (t.platform === "Vicinity Launchpad") { const a = el("a", "registry__above", "On the Launchpad →"); a.href = "/launchpad"; ca.append(a); }
      else ca.textContent = "—";
      const st = el("td");
      st.append(el("span", t.contract ? "tag tag--ok" : /^launching/i.test(t.status || "") ? "tag tag--warn" : "tag", t.contract ? "Live" : t.status));
      tr.append(el("td", null, t.network), el("td", null, t.symbol.startsWith("e.g.") ? `${t.name}, ${t.symbol}` : `${t.name} ($${t.symbol})`), ca, st); // "City coins (one per city), e.g. $UTICA": not two brackets in a row
      return tr;
    }));
  }
  /** No address to show (before the launch): the copy button and the trade links go; the room they held is given back. */
  function hideContract() { $("#ca-copy").hidden = true; $("#ca-links").hidden = true; }
  /** The official contract, its copy button and its trade links: from the chain's answer, or from the settings while the chain is busy. */
  function showContract(m) {
    $("#ca-text").textContent = m;
    $("#ca-copy").hidden = false;
    $("#ca-copy").onclick = () => copyContract(m);
    $("#ca-badge").hidden = false; // the address comes from this site's own settings: it is the official one, chain busy or not
    $("#lnk-solscan").href = `https://solscan.io/token/${m}`;
    $("#lnk-jup").href = `https://jup.ag/tokens/${m}`;
    $("#lnk-raydium").href = `https://raydium.io/launchpad/token/?mint=${m}`;
    $("#lnk-dex").href = `https://dexscreener.com/solana/${m}`;
    // With the Launchpad's coin pages on (LAUNCHPAD_V2), the third tile is our own live chart and details (/coin): DEX Screener lists
    // no pool while $VICINITY is on its bonding curve, and the coin page links DEX Screener itself once it does.
    // the coin answer (/api/coin, LAUNCHPAD_V2 on) feeds the 24-hour chip and the Trades tab; without it the tab says so
    if (official && typeof official.then === "function") official.then((o) => {
      if (o && o.launchpadV2 === true) { chartTile(m); loadCoin(m); } else tradesOff(m);
      if (o && o.swap === true) buyHere(m); else settleBuy("link");
    }, () => { settleBuy("link"); tradesOff(m); });
    else { settleBuy("link"); tradesOff(m); }
    $("#ca-links").hidden = false;
    $("#ca-note").textContent = "This is the only official $VICINITY. Anything else using the name is fake.";
  }
  /**
   * The Buy card (#buy-slot, the top of the page on a phone, the right-hand column on a computer) holds its room unseen from the first
   * paint (.is-pending) until it knows what it shows: the in-app Buy panel, the plain "Buy on Raydium" button (the swap switched off),
   * or nothing (no contract yet, or the swap's settings did not load): then the card's column goes and the page closes up.
   */
  let buyState = "";
  function settleBuy(state) {
    if (buyState === "panel" || buyState === "none" || buyState === state) return; // a panel or a "nothing" is final; a timeout's "link" can still become either
    buyState = state;
    const slot = $("#buy-slot"); if (slot) slot.classList.remove("is-pending");
    const col = $(".token-hero__buy"); if (col) col.hidden = state === "none";
    const hero = $(".token-hero"); if (hero) hero.classList.toggle("is-nobuy", state === "none");
  }
  // a hung answer never leaves a hole: after 4 s the card shows what it has (the Raydium button), and a panel still replaces it
  setTimeout(() => settleBuy("link"), 4000);
  /** With the in-app swap on (SWAP=on): the Buy panel (public/swap.js) is the page's Buy card and the Buy tile scrolls to it. Nobody is sent to raydium.io. */
  function buyHere(m) {
    if (!window.VSwap || !isAddr(m)) { settleBuy("link"); return; }
    let slot = $("#buy-slot");
    if (!slot) { slot = el("div"); slot.id = "buy-slot"; const links = $("#ca-links"); (links && links.parentNode ? links : $("#ca-text")).after(slot); }
    slot.dataset.swap = ""; slot.dataset.out = m; slot.dataset.in = "SOL"; slot.dataset.mode = "buy"; slot.dataset.title = "Buy $VICINITY";
    Promise.resolve(window.VSwap.mount(slot)).then((p) => settleBuy(p ? "panel" : "none"), () => settleBuy("link"));
    // the Jupiter tile is the token's INFORMATION page on jup.ag (its href already): "Jupiter" with an info mark in place of the
    // swap arrows (pages-token.css, pages-coin.css, on data-swap-here) to the eye, "Jupiter token info" to a screen reader, so nobody takes it
    // for a place to buy (the Buy card is the page's one place to buy)
    const j = $("#lnk-jup"); if (j && !j.dataset.swapHere) { j.dataset.swapHere = "1"; const jl = j.querySelector("span:not(.contract__out):not(.sr-only)"); if (jl) { jl.textContent = "Jupiter"; jl.after(el("span", "sr-only", " token info")); } }
    const a = $("#lnk-raydium"); if (!a) return;
    a.href = "#buy-slot"; a.removeAttribute("target"); a.removeAttribute("rel"); a.classList.add("is-here");
    for (const x of a.querySelectorAll(".sr-only")) x.remove();
    const name = a.querySelector("span"); if (name) name.textContent = "Buy here";
    a.addEventListener("click", (e) => { e.preventDefault(); slot.scrollIntoView({ behavior: "smooth", block: "center" }); const i = slot.querySelector(".swap__amt"); if (i) i.focus({ preventScroll: true }); });
  }
  /** The live line under the title: the price, its 24-hour change (from the coin page's answer, when it has one) and the market cap. */
  function paintQuote(price, cap) {
    const p = $("#tk-price"), c = $("#tk-cap"); if (!p || !c) return;
    p.textContent = price ? usd(price) : "Price not available yet";
    p.classList.toggle("is-none", !price);
    c.textContent = price && cap ? `Market cap $${compact(cap)}` : "";
  }
  /** The coin page's answer for $VICINITY (/api/coin): one call feeds the 24-hour chip and the Trades tab; again every minute with the
   *  holder list (the server keeps it 30 s), and on the tab's Refresh. A newer call outranks an older one still on its way. */
  let coinMint = null, coinLoad = 0;
  async function loadCoin(m) {
    if (!isAddr(m)) return;
    coinMint = m;
    const run = ++coinLoad;
    const d = await api(`/api/coin?mint=${encodeURIComponent(m)}`);
    if (run !== coinLoad) return;
    paintChange(d);
    renderTrades(d, m);
  }
  /** The 24-hour change chip: the coin answer's change (Jupiter's, or why there is none); nothing shows without a number. */
  function paintChange(d) {
    const chip = $("#tk-chg"); if (!chip) return;
    const mk = d && d.market, v = mk && typeof mk.priceChange24hPct === "number" && Number.isFinite(mk.priceChange24hPct) ? mk.priceChange24hPct : null;
    if (v == null) return;
    chip.textContent = `${v > 0 ? "▲" : v < 0 ? "▼" : ""} ${Math.abs(v).toFixed(Math.abs(v) >= 10 ? 1 : 2)}% 24h`.trim();
    chip.className = `token-quote__chg ${v > 0 ? "is-up" : v < 0 ? "is-down" : "is-flat"}`;
    const from = mk.sources && typeof mk.sources.change24h === "string" ? mk.sources.change24h : "Jupiter";
    chip.title = `24-hour change · ${from}`;
    const src = $("#st-src"); if (src && !src.dataset.chg) { src.dataset.chg = "1"; src.textContent = `${src.textContent} 24 h change: ${from}.`; }
  }
  /** The third tile becomes "Chart": this site's coin page, in the same tab (no new-tab arrow, nothing to say about one). */
  function chartTile(m) {
    const a = $("#lnk-dex"); if (!a || !isAddr(m)) return;
    a.href = `/coin?mint=${m}`; a.removeAttribute("target"); a.removeAttribute("rel");
    for (const s of a.querySelectorAll(".contract__out, .sr-only")) s.remove();
    const name = [...a.querySelectorAll("span")].find((s) => !s.className); if (name) name.textContent = "Chart";
    a.setAttribute("aria-label", "Chart and live market of $VICINITY");
  }
  /** Copy: the toast says so, and the button itself turns into "Copied" with a tick for a moment (the tick pops in unless motion is reduced). */
  let copiedTimer = 0;
  async function copyContract(m) {
    if (!(await copy(m, "Contract address copied"))) return; // no clipboard: the toast shows the address to copy by hand
    const b = $("#ca-copy"), label = $("#ca-copy-label");
    b.classList.remove("is-copied"); void b.offsetWidth; // a second tap replays the tick
    b.classList.add("is-copied"); label.textContent = "Copied";
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => { b.classList.remove("is-copied"); label.textContent = "Copy address"; }, 1800);
  }
  async function loadToken() {
    const d = await api("/api/token");
    renderRegistry(d.registry);
    launched = Boolean(d.launched);
    // until now the card held the room of the address and its buttons, unseen (the page never jumps, and /token#holders lands where it aims)
    $("#contract").classList.remove("is-pending");
    if (!d.launched) { // before the launch (VICINITY_MINT not set): say so, never a date or a guess
      hideContract(); settleBuy("none"); paintQuote(null); tradesBeforeLaunch();
      $("#ca-text").textContent = "Not published yet";
      $("#ca-note").textContent = "Until it's published here, any \"$VICINITY\" you see is fake.";
      $$('[data-live="mint"], [data-live="freeze"], [data-live="supply2"]').forEach((e) => { e.textContent = "Checked live at launch"; });
      return;
    }
    const m = d.facts ? d.facts.mint : d.mint;
    if (isAddr(m)) showContract(m); else { hideContract(); settleBuy("none"); }
    if (!isAddr(m)) tradesOff(null); // no address: no coin answer to read either
    if (!d.facts) { // the chain is busy: the contract is known, the live checks wait for the next visit
      paintQuote(null);
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
    const supplyText = $("#supply-text"); if (supplyText) supplyText.textContent = fmt(f.supply); // the "Fixed supply" proof card is gone (9 Oct 2026); an older page still fills it
    $("#st-supply").textContent = compact(f.supply);
    if (d.price) { $("#st-price").textContent = usd(d.price); $("#st-mcap").textContent = d.marketCap ? `market cap ${"$" + compact(d.marketCap)}` : ""; }
    else { $("#st-price").textContent = "—"; $("#st-mcap").textContent = "price not available yet"; }
    paintQuote(d.price, d.marketCap);
  }
  /** "Team wallets public": say how many are actually listed (the official list is the one source), never just "Listed". */
  function renderTeamCount(o) {
    const e = $("#team-count"); if (!e) return;
    const n = o && Array.isArray(o.teamWallets) ? o.teamWallets.length : 0, l = o && Array.isArray(o.teamLocks) ? o.teamLocks.length : 0;
    e.textContent = n ? `${n} wallet${n === 1 ? "" : "s"}${l ? ` and ${l} lock${l === 1 ? "" : "s"}` : ""} listed` : "No team wallets yet";
  }
  /** A link to the lock's own page, in a new tab (a screen reader is told so). */
  function lockLink(text) { const a = el("a", null, text); a.href = lock.url; a.target = "_blank"; a.rel = "noopener"; a.append(el("span", "sr-only", " (opens in a new tab)")); return a; }
  /**
   * "60M team tokens locked": what the lock holds right now (its row in the holder list) and a link to its page; without its row (not
   * in the list, the chain busy), the link alone. Until the cliff all of it is locked; after it, part may be unlocked but not yet taken
   * out, so the words become "in the lock". One span holds the words and the link: the line is a flex box (polish.css), and two items
   * would wrap as two columns on a narrow card.
   */
  function renderLock() {
    const e = $("#team-lock-live"); if (!e || lock === undefined) return;
    if (!lock) { e.textContent = "Couldn't check right now"; e.classList.add("is-wait"); return; }
    const row = holders.find((h) => h.owner === lock.address);
    const held = row ? `${fmt(row.amount)} ${Date.now() < Date.parse(lock.cliff) ? "still locked" : "still in the lock"} · ` : null;
    const line = el("span"); line.append(...(held ? [held] : []), lockLink("See the lock"));
    e.replaceChildren(line);
    e.classList.toggle("is-live", Boolean(row));
  }
  /** The team lock from /api/official: its card's line, and its row's tag if the list is on screen already. */
  function setLock(o) {
    const l = o && Array.isArray(o.teamLocks) ? o.teamLocks[0] : null;
    lock = l && isAddr(l.address) && /^https:\/\//.test(String(l.url)) ? l : null;
    renderLock();
    const h = lock && holders.find((x) => x.owner === lock.address);
    const tr = h && $$("#holders-body tr").find((t) => t.dataset.owner === h.owner);
    if (tr) { tr.after(place(h)); tr.remove(); }
  }

  /* ---------- holders table ---------- */
  // The server answers 1,000 wallets at a time (/api/holders?offset=N, `more` says whether to ask again); the page keeps
  // asking until every holder is here. Rows go into the table 250 per animation frame, so a list of 10,000 wallets never
  // freezes the page. The box itself scrolls on its own and, once the live list is in it, has a fixed height (style.css
  // .holders--live .table-scroll), so the page stays the same length however many people hold the token.
  const CHUNK = 250, MAX_PAGES = 200;
  let queue = [], drawing = false, restart = false, loading = false, keepScroll = 0, load = 0, lastSnap = null;
  // The bars' full width: the biggest share in the list. The server lists pools, the team lock and the team wallets first, then
  // people biggest first, so the first row is not always the biggest holding; it is set before a page is drawn.
  let barMax = 1;
  const biggest = (rows) => rows.reduce((m, h) => Math.max(m, Number(h.percent) || 0), 0);
  function row(h) {
    const tr = el("tr"); tr.dataset.owner = h.owner;
    const w = el("td");
    const a = el("a", null, mask(h.owner)); a.href = `https://solscan.io/account/${h.owner}`; a.target = "_blank"; a.rel = "noopener"; a.title = h.owner;
    w.append(a);
    if (isLock(h) && lock && lock.address === h.owner) { const t = lockLink(h.label); t.className = "tag tag--ok"; w.append(t); } // the lock's page: its rules, live
    else if (h.label) w.append(el("span", "tag tag--ok", h.label));
    const pct = el("td", "num", `${pctText(h.percent)}%`);
    const bar = el("span", "pct-bar"), fill = el("span"); fill.style.width = `${Math.min(100, Math.max(2, (h.percent / barMax) * 100))}%`; bar.append(fill); pct.append(bar);
    tr.append(el("td", h.rank ? null : "is-unranked", h.rank ? String(h.rank) : isTeam(h) ? "Team" : isLock(h) ? "Lock" : "Pool"), w, el("td", "num", fmt(h.amount)), pct);
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
      const card = $(".holders");
      // the first live list gives the box its fixed height (style.css), so the FAQ below moves down by the difference: a visit to
      // /token#buy or #verify is put back on its target that once; a refresh changes no height, so it never moves the page
      if (!card.classList.contains("holders--live")) { card.classList.add("holders--live"); reland(); }
    }
    queue.push(...rows);
    if (!drawing && (queue.length || restart)) { drawing = true; requestAnimationFrame(draw); }
  }
  async function loadHolders() {
    const status = $("#holders-status");
    const run = ++load; // Refresh, or the minute timer, while pages are still coming: the older load stops where it is
    const d = await api("/api/holders");
    if (run !== load) return;
    if (!d.launched) { status.textContent = "The live holder list opens the moment $VICINITY launches."; renderLock(); return; }
    $("#holders-refresh").hidden = false;
    if (d.error || !Array.isArray(d.holders)) { status.textContent = "The blockchain is busy right now. Try Refresh in a minute."; renderLock(); return; }
    // the snapshot already on screen (the server keeps one for a minute): no more pages to ask for, nothing to redraw; the line is
    // written again all the same (the same list comes back marked Delayed once the chain cannot be read)
    if (lastSnap && d.full && d.updatedAt === lastSnap.at && d.count === lastSnap.count) { setStatus(d, lastSnap.people, true); return; }
    lastSnap = null;
    holders = d.holders;
    barMax = biggest(holders) || 1;
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
      barMax = Math.max(barMax, biggest(fresh)); // never bigger than the first page's in the server's order; a bar never passes 100% anyway
      show(fresh, false);
    }
    loading = false;
    if (!drawing) restore(true); // every row is drawn already; otherwise draw() does this when its queue runs out
    const people = holders.filter((h) => h.rank);
    const total = d.total ?? people.length;
    setStatus(d, people.length, complete);
    if (complete && d.full) lastSnap = { at: d.updatedAt, count: d.count, people: people.length };
    $("#st-holders").textContent = d.full ? fmt(total) : `${people.length}+`;
    $("#st-top10").textContent = `${pctText(people.slice(0, 10).reduce((s, h) => s + h.percent, 0))}%`;
    renderLock();
  }
  /**
   * The line over the list: how many holders and when the list was read. "Delayed · list from HH:MM" when the server answered an older
   * list because the chain could not be read (the time is the list's, never now). Under the list, the supply the percentages are a share
   * of: the one read from the chain with the list, to the mint's six decimals (999,999,999.999998 today), never the rounded 1,000,000,000.
   */
  function setStatus(d, people, complete) {
    const status = $("#holders-status"), total = d.total ?? people, at = hhmm(d.updatedAt);
    const when = d.stale === true ? `Delayed · list from ${at}` : `updated ${at}`;
    status.textContent = !d.full ? `Top ${holders.length} wallets · ${when}` : complete ? `${fmt(total)} holders · ${when}` : `${fmt(total)} holders · showing the top ${fmt(people)} · ${when}`;
    status.classList.toggle("is-delayed", d.stale === true);
    const basis = $("#holders-basis"), supply = typeof d.supply === "number" && Number.isFinite(d.supply) && d.supply > 0;
    if (basis) {
      basis.hidden = !supply;
      if (supply) basis.textContent = d.stale === true ? `Percentages use the on-chain supply of ${fmt(d.supply, 6)} $VICINITY, read with the list.` : `Percentages use the live on-chain supply of ${fmt(d.supply, 6)} $VICINITY.`;
    }
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

  /* ---------- where does a wallet stand? Check rank in the find box; the answer pops up over the page ---------- */
  let lastLookup = null;
  const pop = $("#rank-pop");
  async function lookup(addr) {
    const set = (id, t) => ($(id).textContent = t);
    /** "To pass the next wallet" and "Founder amount": shown, or not (a team wallet). Guarded: a page from before them still checks a rank. */
    const extraFacts = (on) => ["#rank-next-row", "#rank-founder-row"].forEach((id) => { const e = $(id); if (e) e.hidden = !on; });
    const btn = $("#lookup button"); if (btn.disabled) return; // one check at a time (Enter while the last one is on its way)
    lastLookup = null; // set again only when the pop-up shows a wallet's facts: a message alone has no row to show, after a refresh too
    // every lookup starts from a blank card: nothing of the wallet looked up before may stay on it
    const blank = () => {
      set("#rank-num", "—"); set("#rank-of", ""); set("#rank-pct", "");
      ["#rank-amount", "#rank-share", "#rank-next", "#rank-founder"].forEach((i) => set(i, "—"));
      $("#rank-meter").style.width = "0%";
      extraFacts(true); // a team wallet hides them
    };
    /** Only a message to give (no wallet's facts): the meter and the facts step aside. */
    const only = (text) => { set("#rank-pct", text); $("#rank-bar").hidden = true; $("#rank-facts").hidden = true; $("#rank-show").hidden = true; };
    if (!isAddr(addr)) { // part of an address only filters the list; a whole one that isn't Solana's (0x..., a typo) says so
      blank(); set("#rank-addr", "");
      only(addr.length >= 32 ? "That doesn't look like a Solana wallet address." : "Paste a full wallet address to check its rank."); openPop(); return;
    }
    btn.disabled = true; btn.textContent = "Checking…";
    const d = await api(`/api/rank?address=${encodeURIComponent(addr)}`);
    btn.disabled = false; btn.textContent = "Check rank";
    $("#rank-addr").textContent = addr;
    blank(); $("#rank-bar").hidden = false; $("#rank-facts").hidden = false;
    // the server's check is stricter than the page's (a character missing from a 44-character address still looks like one here)
    if (d.error === "bad_address") { only("That doesn't look like a Solana wallet address."); openPop(); return; }
    if (d.error === "chain_unavailable") { only("The blockchain is busy. Try again in a minute."); openPop(); return; }
    // many checks from one shared connection (an office, a campus, a mobile network): say so, never "not launched"
    if (d.error === "slow_down") { only("Too many checks from your network. Try again in a minute."); openPop(); return; }
    // no connection, a server error, an answer without a launch state: never "not launched" on a live token
    if (d.error || typeof d.launched !== "boolean") { only("Couldn't check right now. Try again in a minute."); openPop(); return; }
    if (!d.launched) {
      set("#rank-num", "—"); set("#rank-of", "");
      set("#rank-pct", "Ranks go live the moment $VICINITY launches. Save this page and check back.");
      ["#rank-amount", "#rank-share", "#rank-next", "#rank-founder"].forEach((i) => set(i, "At launch"));
      $("#rank-meter").style.width = "0%"; $("#rank-show").hidden = true;
      openPop(); return;
    }
    lastLookup = addr;
    const amount = d.amount || 0;
    set("#rank-amount", `${fmt(amount)} $VICINITY`);
    // the balance-only answer (the full list is out of reach) has no share: a dash, not "<0.01%" for a wallet holding 9%
    set("#rank-share", !amount ? "0%" : typeof d.percent === "number" ? `${pctText(d.percent)}%` : "—");
    const founderMin = d.founderMin || 100_000; // the smallest founder amount: the exact one depends on the city
    set("#rank-founder", amount >= FOUNDER_MAX ? "✓ Enough for any city (hold it 7 days)"
      : amount >= founderMin ? "✓ Enough for smaller cities (hold it 7 days)" : `${fmt(founderMin - amount)} to reach the smallest`);
    if ((d.team === true || d.lock === true) && !d.rank) { // a published team wallet or the team lock: what it holds, but no rank (no "Rank" line at all), no meter, no wallet to pass, no founder amount
      // a team wallet with a name of its own says it ("Team wallet (FOMO): …"), as its tag in the list does; "(public)" is not repeated
      const named = typeof d.label === "string" && /^Team wallet \((?!public\)).+\)$/.test(d.label) ? d.label : "Team wallet";
      set("#rank-pct", d.lock === true ? "Team lock: the team's $VICINITY on Jupiter Lock, labeled in the list. Ranks are for people only."
        : `${named}: published by Vicinity and labeled in the list. Ranks are for people only.`);
      set("#rank-founder", "—"); $("#rank-bar").hidden = true; extraFacts(false);
    }
    else if (d.label && !d.rank) { // a pool or curve: no rank, no wallet to pass, not a founder
      set("#rank-num", "Pool"); set("#rank-of", d.label); set("#rank-pct", "Pools and curves are listed but not ranked.");
      set("#rank-founder", "—");
    }
    else if (d.rank) {
      set("#rank-num", `#${fmt(d.rank)}`); set("#rank-of", `of ${fmt(d.total)} holders`);
      set("#rank-pct", d.rank === 1 ? "The biggest holder of all 🏆" : `Top ${pctText(d.percentile)}% of all holders`);
      set("#rank-next", d.rank === 1 ? "You're #1 🏆" : d.next ? `${fmt(Math.ceil(d.next.gap))} to pass #${d.next.rank}` : "—");
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
    openPop();
  }

  /* the pop-up: a modal <dialog> (the page behind it is inert: Tab never reaches it). It scales and fades in from the box (style.css; at once
     with reduced motion), says its answer when it takes the keyboard (named by its title, described by the rank and the line under it),
     and closes with its button, Escape or a tap outside it; the keyboard then goes back to the box's Check rank button. Closed, it takes
     no room on the page. */
  let popTimer = 0, popH = 460; // its height the last time it was open (a first guess before that): to place it before it opens
  /** A phone, or a screen too short for a pop-up by the box (a phone on its side): the answer is a sheet at the bottom (style.css). */
  const sheet = () => !window.matchMedia || window.matchMedia("(max-width: 600px), (max-height: 500px)").matches;
  const headBottom = () => { const head = $(".site-header"); return head ? head.getBoundingClientRect().bottom : 0; }; // the sticky header covers this much
  /** The box in the window as it is laid out: the holder card may still be rising in (site.js reveals it with a transform as it scrolls
   *  into view, as a /token?address= visit brings it), and the pop-up belongs where the box lands, not where it is mid-way. */
  function boxRect() {
    const box = $("#lookup");
    let top = -window.scrollY - box.clientTop, left = -window.scrollX - box.clientLeft;
    for (let e = box; e; e = e.offsetParent) { top += e.offsetTop + e.clientTop; left += e.offsetLeft + e.clientLeft; }
    return { top, bottom: top + box.offsetHeight, right: left + box.offsetWidth };
  }
  function openPop() {
    const gate = $("#termsgate");
    // a first visit straight to /token?address=...: the answer waits for the terms (the page behind the gate is inert)
    if (gate && !gate.hidden) { $("#termsgate-agree").addEventListener("click", openPop, { once: true }); return; }
    const big = $("#rank-big"), num = $("#rank-num");
    big.hidden = num.textContent === "—" && !$("#rank-of").textContent; // a message alone: no "Rank —" above it
    num.classList.toggle("is-none", num.textContent === "—"); // no rank: a plain dash, not a coloured bar
    pop.setAttribute("aria-describedby", big.hidden ? "rank-pct" : "rank-big rank-pct");
    clearTimeout(popTimer); pop.classList.remove("is-closing");
    if (!pop.open) {
      // on a computer it opens by the box: a box out of the window (a shared /token?address= link, or the reader scrolled away while
      // the check ran) comes into view first, as /token#verify lands (the field takes the keyboard, so the holder card shows at once
      // rather than rising in: site.js), and the answer hangs under it instead of floating over the hero
      const r = sheet() ? null : boxRect();
      if (r && (r.top < headBottom() || r.bottom > window.innerHeight)) { $("#holders-find").focus({ preventScroll: true }); $("#verify").scrollIntoView({ behavior: "instant" }); }
      anchorPop(); // placed by the box before it opens...
      // ...because showModal() focuses its close button and scrolls the page to it; under html { scroll-behavior: smooth } that scroll
      // runs on after this function (the first open of a visit landed at the top of the page, the pop-up off screen). Instant, and undone.
      const root = document.documentElement, sb = root.style.scrollBehavior, x = window.scrollX, y = window.scrollY;
      root.style.scrollBehavior = "auto";
      pop.showModal();
      if (window.scrollX !== x || window.scrollY !== y) window.scrollTo({ left: x, top: y, behavior: "instant" });
      root.style.scrollBehavior = sb;
    }
    anchorPop(); // ...and again at its real size, from where the page is
    $("#rank-close").focus({ preventScroll: true });
    if (pop.scrollIntoView) pop.scrollIntoView({ block: "nearest", behavior: window.V.reduced ? "auto" : "smooth" });
  }
  /** On a computer it hangs from the box: under it, right edges lined up (above it when only there is room, under the sticky header); on
   *  a phone it is a sheet at the bottom of the screen (style.css). Absolute in the top layer, so it scrolls with the page, by the box. */
  function anchorPop() {
    if (sheet()) { pop.classList.remove("is-above"); return; } // a sheet grows from the bottom of the screen
    const vw = document.documentElement.clientWidth, vh = window.innerHeight, r = boxRect();
    const w = pop.open ? pop.offsetWidth : Math.min(420, vw - 32), h = pop.open ? (popH = pop.offsetHeight) : popH; // closed, it has no size
    const above = r.bottom + 8 + h > vh - 8 && r.top - 8 - h >= headBottom() + 8;
    pop.style.setProperty("--pop-x", `${Math.round(Math.max(16, Math.min(r.right - w, vw - w - 16)) + window.scrollX)}px`);
    pop.style.setProperty("--pop-y", `${Math.round((above ? r.top - 8 - h : r.bottom + 8) + window.scrollY)}px`);
    pop.classList.toggle("is-above", above);
  }
  function closePop() {
    if (!pop.open || pop.classList.contains("is-closing")) return;
    if (window.V.reduced) { pop.close(); return; }
    pop.classList.add("is-closing"); // a quick fade (style.css), then it is gone
    popTimer = setTimeout(() => pop.close(), 140);
  }
  pop.addEventListener("close", () => { clearTimeout(popTimer); pop.classList.remove("is-closing"); $("#lookup button").focus({ preventScroll: true }); });
  pop.addEventListener("cancel", (e) => { e.preventDefault(); closePop(); }); // Escape: the same quick fade
  // the card fills the dialog: a click on the dialog itself is outside it; one that began on the card (selecting the address, say) is not
  let downOutside = false;
  pop.addEventListener("pointerdown", (e) => { downOutside = e.target === pop; });
  pop.addEventListener("click", (e) => { if (e.target === pop && downOutside) closePop(); downOutside = false; });
  $("#rank-close").addEventListener("click", closePop);
  window.addEventListener("resize", () => { if (pop.open) anchorPop(); });
  $("#lookup").addEventListener("submit", (e) => { e.preventDefault(); lookup($("#holders-find").value.trim()); });
  // closes the pop-up, brings the list into view and scrolls the table (not the page) to the wallet's row, highlighted among its
  // neighbours: the address typed in the box would otherwise have filtered the list down to that one row
  $("#rank-show").addEventListener("click", () => {
    const addr = lastLookup; closePop();
    selectTab("holders"); // the list is in the Holders tab
    $("#holders-find").value = ""; filter();
    $("#holders-scroll").scrollIntoView({ block: "nearest", behavior: window.V.reduced ? "auto" : "smooth" });
    mark(addr);
  });

  /* ---------- Trades | Holders: one block, two tabs ---------- */
  // The Launchpad's tab strip: arrow keys move between the tabs (Home and End to the ends), the chosen tab is the strip's one Tab stop
  // (WAI-ARIA tabs), and a choice goes into the address bar as #trades or #holders without a jump. Trades opens first; a link into the
  // holder list or the rank check (/token#holders, #verify, #holders-scroll, ?address=) opens Holders, and so does a hash that changes
  // to one of those while the page is open (the FAQ's "box above the holder list").
  const TABS = ["trades", "holders"];
  const tabs = () => $$("#tk-tabs [role=tab]");
  /** The tab a hash asks for, or null: #holders and anything inside the Holders card, or #trades. */
  const tabOf = (hash) => (/^#(holders|verify|lookup|rank-)/.test(hash) ? "holders" : hash === "#trades" ? "trades" : null);
  function selectTab(name, { focus = false, url = false } = {}) {
    if (!TABS.includes(name)) return;
    tabs().forEach((b) => { const on = b.dataset.tab === name; b.setAttribute("aria-selected", String(on)); b.tabIndex = on ? 0 : -1; });
    for (const t of TABS) { const p = $(`#${t}-panel`); if (p) p.hidden = t !== name; }
    // the reader's choice rides in the address bar (a #hash set directly would scroll the page to it; replaceState does not); a link's own hash stays
    if (url && window.history && typeof window.history.replaceState === "function") { try { window.history.replaceState(null, "", `#${name}`); } catch { /* an odd browser: the page still works */ } }
    if (focus) { const b = tabs().find((x) => x.dataset.tab === name); if (b) b.focus(); }
  }
  tabs().forEach((b, i, all) => {
    b.addEventListener("click", () => selectTab(b.dataset.tab, { url: true }));
    b.addEventListener("keydown", (e) => {
      const n = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? all.length - 1 : null;
      if (n === null) return;
      e.preventDefault(); selectTab(all[(n + all.length) % all.length].dataset.tab, { focus: true, url: true });
    });
  });
  selectTab(tabOf(location.hash) || (new URLSearchParams(location.search).has("address") ? "holders" : "trades"));

  /* ---------- the Trades tab ---------- */
  // The newest buys and sells from the coin answer (Raydium LaunchLab's own list for the curve, read by the server; a trader's wallet comes
  // masked, with its Solscan page as the link, the one rule the holder list follows). Only while the pool is on the curve: once the coin has graduated (or the stage is
  // unknown) the last curve trades could pass for the open market's, so the tab says where those are instead of showing them.
  const TRADES_SHOWN = 20, TRADES_MAX = 50, TXID = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/, WALLET_URL = /^https:\/\/solscan\.io\/account\/[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  let tradeCount = 0, tradeKey = null; // tradeKey: the rows on screen (their transactions, in order); the same rows again redraw nothing, so a reader's focus on a link in the list survives the minute refresh
  const solText = (n) => (n >= 100 ? fmt(n) : n >= 1 ? n.toFixed(2) : n.toFixed(4));
  const outLink = (text, href, cls) => { const a = el("a", cls, text); a.href = href; a.target = "_blank"; a.rel = "noopener"; a.append(el("span", "sr-only", " (opens in a new tab)")); return a; };
  const solscanNote = (m) => (isAddr(m) ? ["See every trade on ", outLink("Solscan", `https://solscan.io/token/${m}`), "."] : null);
  const validTrade = (t) => Boolean(t) && typeof t === "object" && (t.side === "buy" || t.side === "sell") && typeof t.txid === "string" && TXID.test(t.txid)
    && typeof t.tokens === "number" && Number.isFinite(t.tokens) && t.tokens > 0 && Number.isFinite(Date.parse(t.at));
  /** One state of the tab: the sentence over the list (text or nodes), one line in the rows' place (or none), the note under them. */
  const tradesCover = (cover) => { const c = $("#trades-cover"); if (c) c.replaceChildren(...(Array.isArray(cover) ? cover : [cover])); };
  function tradesSay(cover, line, note) {
    const panel = $("#trades-panel"); if (panel) panel.classList.remove("is-loading"); // the placeholder rows' shimmer ends with the first answer
    tradesCover(cover);
    const l = $("#trades-list"); if (l) l.replaceChildren(...(line ? [el("li", "trades__empty", line)] : []));
    const n = $("#trades-note"); if (n) { n.replaceChildren(...(note || [])); n.hidden = !note; }
    tradeKey = null; tradeCount = 0; showAll();
  }
  const tradesBeforeLaunch = () => tradesSay("The live trade list opens the moment $VICINITY launches.", null, null);
  /** No coin answer to read (the coin pages are switched off, or their settings did not load): said plainly, with the way to Solscan. */
  const tradesOff = (m) => tradesSay("Recent trades are not available here yet.", null, solscanNote(m));
  /** "Show all N" under the newest 20 when the answer holds more (up to 50); open, it stays open across a refresh. */
  function showAll() {
    const all = $("#trades-all"), list = $("#trades-list"); if (!all || !list) return;
    all.hidden = tradeCount <= TRADES_SHOWN;
    const open = list.classList.contains("is-all");
    all.textContent = open ? "Show fewer" : `Show all ${tradeCount}`; all.setAttribute("aria-expanded", String(open));
  }
  function tradeRow(t) {
    const li = el("li", `trade is-${t.side}`);
    const sol = typeof t.amount === "number" && Number.isFinite(t.amount) && t.amount > 0 ? `${solText(t.amount)} ${typeof t.symbol === "string" && /^[A-Za-z0-9]{1,12}$/.test(t.symbol) ? t.symbol : "SOL"}` : "—";
    const when = el("time", "trade__when", ago(t.at)); when.dateTime = t.at; when.title = new Date(Date.parse(t.at)).toLocaleString();
    const meta = el("span", "trade__meta");
    const wallet = typeof t.wallet === "string" && t.wallet ? t.wallet : "—";
    // the masked wallet, linked to its Solscan page when the answer carries one (one rule with the holder list: masked and linked); plain text otherwise
    const who = typeof t.walletUrl === "string" && WALLET_URL.test(t.walletUrl) ? outLink(wallet, t.walletUrl, "trade__who") : el("span", "trade__who", wallet);
    meta.append(who, " · ", when, " · ", outLink("Solscan", `https://solscan.io/tx/${t.txid}`, "trade__tx"));
    li.append(el("span", `trade__side is-${t.side}`, t.side === "buy" ? "Buy" : "Sell"), el("span", "trade__tok", `${fmt(t.tokens)} $VICINITY`), el("span", "trade__sol", sol), meta);
    return li;
  }
  function renderTrades(d, m) {
    const refresh = $("#trades-refresh"); if (refresh) refresh.hidden = false;
    const ok = Boolean(d) && d.ok === true, tr = ok ? d.trades : null, mk = ok && d.market && typeof d.market === "object" ? d.market : null;
    if (!tr || typeof tr !== "object" || !mk) { tradesSay("Recent trades are not available right now. Try Refresh in a minute.", null, solscanNote(m)); return; }
    if (mk.stage !== "curve") { // the stage guard: nothing here may pass for the open market's trades
      if (mk.stage == null) tradesSay("Could not check the pool right now. Try Refresh in a minute.", null, solscanNote(m));
      else tradesSay("Trade history for the open market is not available here yet.", null, ["See ", outLink("Solscan", `https://solscan.io/token/${m}`), " or ", outLink("DEX Screener", `https://dexscreener.com/solana/${m}`), "."]);
      return;
    }
    const rows = (Array.isArray(tr.rows) ? tr.rows : []).filter(validTrade).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, TRADES_MAX);
    // the coverage sentence: the venue as the answer names it, and the answer's time. An older list the server fell back to (stale) says
    // Delayed and gives no "as of": the answer's time is not the list's, and each trade shows its own
    const venue = typeof tr.source === "string" && tr.source ? tr.source : "Raydium LaunchLab", at = hhmm(d.asOf);
    const cover = tr.stale === true ? [`Trades on the ${venue} curve · `, el("span", "tk-delayed", "Delayed"), " · older list, each trade shows its own time"]
      : [at ? `Trades on the ${venue} curve · as of ${at}` : `Trades on the ${venue} curve`];
    if (!rows.length) { tradesSay(cover, /could not be re(ached|ad)/i.test(String(tr.missing || "")) ? "Recent trades are not available right now. Try Refresh in a minute." : "No trades yet", null); return; }
    const key = rows.map((t) => t.txid).join(" ");
    if (key === tradeKey) { tradesCover(cover); return; } // the rows on screen already: only the sentence is written again
    tradesSay(cover, null, null);
    $("#trades-list").replaceChildren(...rows.map((t, i) => { const li = tradeRow(t); if (i >= TRADES_SHOWN) li.classList.add("is-more"); return li; }));
    tradeKey = key; tradeCount = rows.length; showAll();
  }
  const tradesAll = $("#trades-all"); if (tradesAll) tradesAll.addEventListener("click", () => { $("#trades-list").classList.toggle("is-all"); showAll(); });
  const tradesRefresh = $("#trades-refresh"); if (tradesRefresh) tradesRefresh.addEventListener("click", () => { if (coinMint) loadCoin(coinMint); });

  /* ---------- old links: /token#buy opens "How do I get $VICINITY?" in the FAQ, /token#verify lands on the box (and focuses it) ---------- */
  // the browser itself focuses a link's target (#verify can take the focus: tabindex -1), also when the hash was #verify already;
  // the keyboard goes on into the field. A click or tap inside the box's area (the line under it, say) focuses #verify too: that one
  // stays put, so a tap on the text neither opens a phone's keyboard nor stops a selection.
  let tapped = false;
  window.addEventListener("pointerdown", (e) => { tapped = $("#verify").contains(e.target); }, true);
  window.addEventListener("keydown", () => { tapped = false; }, true);
  $("#verify").addEventListener("focus", () => { if (!tapped) $("#holders-find").focus({ preventScroll: true }); });
  function land(smooth) {
    const behavior = smooth && !window.V.reduced ? "smooth" : "instant";
    const tab = tabOf(location.hash); if (tab) selectTab(tab); // a link into the holder list opens Holders first (the box takes the keyboard only shown)
    if (location.hash === "#buy") { $("#buy").open = true; $("#buy").scrollIntoView({ behavior }); }
    else if (location.hash === "#verify") { $("#verify").scrollIntoView({ behavior }); $("#holders-find").focus({ preventScroll: true }); }
    else if (location.hash === "#trades") $("#holders").scrollIntoView({ behavior }); // nothing is called "trades": the block is the holders section
  }
  // what loads above them moves both (the contract card when the token facts come, the live list's fixed height above the FAQ, the
  // browser's own pass at the link when the page has loaded), so until the reader moves the page themselves, the visit is put back on it
  let landing = location.hash === "#buy" || location.hash === "#verify" || location.hash === "#trades";
  function reland() { if (landing) requestAnimationFrame(() => { if (landing) land(false); }); }
  for (const t of ["wheel", "touchstart", "keydown", "pointerdown"]) window.addEventListener(t, () => { landing = false; }, { passive: true });
  window.addEventListener("hashchange", () => { landing = false; land(true); });
  window.addEventListener("load", reland);
  land(false);

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

  loadToken().then(reland);
  loadHolders();
  if (official && official.then) official.then(renderTeamCount, () => renderTeamCount(null));
  if (official && official.then) official.then(setLock, () => setLock(null));
  setInterval(() => { if (launched && !document.hidden) { loadHolders(); if (coinMint) loadCoin(coinMint); } }, 60_000);
  const q = new URLSearchParams(location.search).get("address");
  if (q) { $("#holders-find").value = q; lookup(q); } // the rows are filtered as they land
})();
