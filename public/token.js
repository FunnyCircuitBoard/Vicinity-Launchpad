// Token page: live token facts, every holder (the table scrolls, not the page; it is loaded in pages and drawn in chunks) with one box that
// finds a wallet in the list and checks where any wallet stands (the answer pops up over the page), the official token list, the link
// checker and the FAQ (old links to /token#buy open its "How do I get $VICINITY?"). Everything comes from this site's /api (read live from Solana).
(() => {
  "use strict";
  const { $, $$, el, api, copy, fmt, compact, mask, isAddr, official } = window.V;
  const FOUNDER_MAX = 1_000_000; // the top of the Stake Ladder (100K to 1M by city size, see /rules#ladder)
  const pctText = (p) => (p >= 10 ? p.toFixed(1) : p >= 0.01 ? p.toFixed(2) : "<0.01");
  const usd = (n) => (n >= 1 ? "$" + n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "$" + n.toPrecision(3));
  /** A published team wallet (labelled "Team wallet (public)" by the server): shown and labelled, never ranked, like a pool. */
  const isTeam = (h) => !h.rank && /^Team wallet/.test(h.label || "");
  let holders = [], launched = false;

  /* ---------- token facts ---------- */
  function renderRegistry(list) {
    const body = $("#registry-body"); if (!body || !Array.isArray(list)) return;
    body.replaceChildren(...list.map((t) => {
      const tr = el("tr");
      const ca = el("td");
      // the official contract is printed once on the page (the card at the top): the row points at it; a token without a contract shows a dash (its status is the tag)
      if (isAddr(t.contract)) { const a = el("a", "registry__above", "Shown above ↑"); a.href = "#contract"; a.title = t.contract; ca.append(a); } else ca.textContent = "—";
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
    if (official && typeof official.then === "function") official.then((o) => { if (o && o.launchpadV2 === true) chartTile(m); });
    $("#ca-links").hidden = false;
    $("#ca-note").textContent = "This is the only official $VICINITY. Anything else using the name is fake.";
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
      hideContract();
      $("#ca-text").textContent = "Not published yet";
      $("#ca-note").textContent = "Until it's published here, any \"$VICINITY\" you see is fake.";
      $$('[data-live="mint"], [data-live="freeze"], [data-live="supply2"]').forEach((e) => { e.textContent = "Checked live at launch"; });
      return;
    }
    const m = d.facts ? d.facts.mint : d.mint;
    if (isAddr(m)) showContract(m); else hideContract();
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
    const supplyText = $("#supply-text"); if (supplyText) supplyText.textContent = fmt(f.supply); // the "Fixed supply" proof card is gone (9 Oct 2026); an older page still fills it
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
    tr.append(el("td", h.rank ? null : "is-unranked", h.rank ? String(h.rank) : isTeam(h) ? "Team" : "Pool"), w, el("td", "num", fmt(h.amount)), pct);
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
    if (d.team === true && !d.rank) { // a published team wallet: what it holds, but no rank (no "Rank" line at all), no meter, no wallet to pass, no founder amount
      set("#rank-pct", "Team wallet: published by Vicinity and labeled in the list. Ranks are for people only.");
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
    $("#holders-find").value = ""; filter();
    $("#holders-scroll").scrollIntoView({ block: "nearest", behavior: window.V.reduced ? "auto" : "smooth" });
    mark(addr);
  });

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
    if (location.hash === "#buy") { $("#buy").open = true; $("#buy").scrollIntoView({ behavior }); }
    else if (location.hash === "#verify") { $("#verify").scrollIntoView({ behavior }); $("#holders-find").focus({ preventScroll: true }); }
  }
  // what loads above them moves both (the contract card when the token facts come, the live list's fixed height above the FAQ, the
  // browser's own pass at the link when the page has loaded), so until the reader moves the page themselves, the visit is put back on it
  let landing = location.hash === "#buy" || location.hash === "#verify";
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
  setInterval(() => { if (launched && !document.hidden) loadHolders(); }, 60_000);
  const q = new URLSearchParams(location.search).get("address");
  if (q) { $("#holders-find").value = q; lookup(q); } // the rows are filtered as they land
})();
