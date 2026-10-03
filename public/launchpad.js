// Launchpad page: live countdown to the opening, and an "add to my calendar" file.
(() => {
  "use strict";
  const { $, $$, official, opensAt, reduced } = window.V;
  const START = Date.parse("2026-09-26T00:00:00Z"); // countdown bar starts here
  const pad = (n) => String(n).padStart(2, "0");
  let last = {};

  function tick() {
    const at = opensAt(), ms = Math.max(0, at - Date.now());
    const parts = { days: Math.floor(ms / 86400000), hours: Math.floor((ms % 86400000) / 3600000), minutes: Math.floor((ms % 3600000) / 60000), seconds: Math.floor((ms % 60000) / 1000) };
    for (const [k, v] of Object.entries(parts)) {
      const e = $(`[data-cd="${k}"]`); if (!e) continue;
      const txt = k === "days" ? String(v) : pad(v);
      if (last[k] !== txt) { e.textContent = txt; if (!reduced && last[k] !== undefined) { e.classList.remove("is-tick"); void e.offsetWidth; e.classList.add("is-tick"); } last[k] = txt; }
    }
    $("#countdown")?.classList.toggle("is-open", ms === 0);
    const bar = $("#lp-bar"); if (bar) bar.style.width = `${Math.min(100, Math.max(0, ((Date.now() - START) / (at - START)) * 100)).toFixed(2)}%`;
    const d = new Date(at);
    // Always stated in New York time; the line below gives the visitor's own time.
    const ny = { timeZone: "America/New_York" };
    $("#lp-date").textContent = `${d.toLocaleDateString("en-US", { ...ny, month: "long", day: "numeric", year: "numeric" })} · ${d.toLocaleTimeString("en-US", { ...ny, hour: "numeric", minute: "2-digit", second: "2-digit" })} New York time`;
    $("#lp-local").textContent = ms === 0 ? "The Launchpad is open." : `Opens ${d.toLocaleString(undefined, { dateStyle: "full", timeStyle: "medium" })} (your time).`;
  }
  official.then(tick); tick(); setInterval(tick, 1000);

  // A standard calendar file, made right here in the browser.
  $("#lp-cal")?.addEventListener("click", () => {
    const at = new Date(opensAt()), stamp = (t) => t.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Vicinity//Launchpad//EN", "BEGIN:VEVENT", `UID:launchpad-${at.getTime()}@vicinity.city`,
      `DTSTAMP:${stamp(new Date())}`, `DTSTART:${stamp(at)}`, `DTEND:${stamp(new Date(at.getTime() + 3600000))}`,
      "SUMMARY:Vicinity Launchpad opens", "DESCRIPTION:Every city gets its own coin. Details: https://vicinity.city/launchpad", "URL:https://vicinity.city/launchpad",
      "END:VEVENT", "END:VCALENDAR"].join("\r\n");
    const a = document.createElement("a");
    a.href = "data:text/calendar;charset=utf-8," + encodeURIComponent(ics);
    a.download = "vicinity-launchpad.ics";
    document.body.append(a); a.click(); a.remove();
  });
  void $$;
})();

// Founding Supporter snapshot: status, and any wallet's amount + Merkle proof.
(() => {
  "use strict";
  const { $, el, api, fmt, isAddr } = window.V;
  let snap = null;
  (async () => {
    const d = await api("/api/snapshots");
    snap = (d.snapshots || []).find((s) => s.status !== "cancelled") || null;
    const st = $("#snap-status"); if (!st) return;
    if (snap) st.textContent = `Snapshot #${snap.id} (cutoff ${new Date(snap.cutoff).toUTCString()}): ${snap.status === "active" ? "final" : `challenge period until ${new Date(snap.activatesAt).toLocaleString()}`} · ${fmt(snap.holders)} wallets · Merkle root ${snap.merkleRoot.slice(0, 16)}…`;
    else st.textContent = d.scheduledCutoff ? `Cutoff scheduled for ${new Date(d.scheduledCutoff).toUTCString()}.` : "The cutoff hasn't been announced yet. It will be, here, well ahead of time.";
  })();
  $("#snap-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const out = $("#snap-result"), w = $("#snap-input").value.trim();
    if (!isAddr(w)) { out.replaceChildren(el("p", "wallet__error", "That doesn't look like a Solana wallet address.")); return; }
    if (!snap) { out.replaceChildren(el("p", "muted", "No snapshot has been published yet.")); return; }
    const r = await api(`/api/snapshots/${snap.id}/proof?wallet=${encodeURIComponent(w)}`);
    if (!r.eligible) { out.replaceChildren(el("p", null, "This wallet isn't in the snapshot.")); return; }
    const proof = el("pre", "formula", JSON.stringify({ leaf: r.leaf, proof: r.proof, root: r.snapshot.merkleRoot }, null, 1));
    out.replaceChildren(el("p", null, `✓ Founding Supporter: ${fmt(r.amount / 1e6)} $VICINITY counted${r.verified ? " · proof verified" : ""}.`), proof);
  });
})();

// City coins (switched on with LAUNCHPAD_V2=on): Live | New | Upcoming | Trending over the one /api/launchpad answer, with
// search, country/status filters and sorting done here in the page. Nothing below runs, and nothing is requested, unless
// /api/official (which site.js already asks for) says launchpadV2 is true; with the switch off the section stays hidden.
(() => {
  "use strict";

  /* =====================================================================
     Pure helpers: no page, no network (test/launchpad-ui.test.js runs them in node)
     ===================================================================== */
  const NEW_DAYS = 7; // "New" = live for less than 7 days: a default until the owner decides otherwise
  const TABS = ["live", "new", "upcoming", "trending"];
  const SORTS = ["volume", "mcap", "liquidity", "holders", "newest", "change", "name"];
  const TAB_NOTE = {
    live: "Live: coins with a recorded contract.",
    new: `New: live for less than ${NEW_DAYS} days, newest first.`,
    upcoming: "Upcoming: designed, or waiting for the contract check.",
    trending: "Trending: by 24-hour volume.",
  };
  const SOL_MINT = "So11111111111111111111111111111111111111112";
  const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  const isAddr = (a) => typeof a === "string" && ADDR_RE.test(a);
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const str = (v) => (typeof v === "string" ? v : "");

  /** Search text the way people type it: no accents, no case, no leading $. */
  const norm = (s) => str(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim().replace(/^\$+/, "").trim();
  const searchText = (c, countryNames) => {
    const city = c.city || {};
    const country = str(city.country);
    return [c.ticker, c.name, city.name, country, countryNames && countryNames[country]].map(norm).filter(Boolean);
  };
  /** Does a card match the search box? Every word must appear at the start of a word of the ticker, name, city or country. */
  function matches(c, q, countryNames) {
    const words = norm(q).split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    const hay = searchText(c, countryNames);
    return words.every((w) => hay.some((h) => h === w || h.startsWith(w) || h.split(/[\s,.-]+/).some((part) => part.startsWith(w))));
  }

  const isLive = (c) => c && c.status === "live";
  const launchedMs = (c) => { const t = Date.parse(str(c.launchedAt)); return Number.isFinite(t) ? t : null; };
  const designedMs = (c) => { const t = Date.parse(str(c.designedAt)); return Number.isFinite(t) ? t : null; };
  const isNew = (c, now) => { const t = launchedMs(c); return isLive(c) && t != null && now - t < NEW_DAYS * 86400000 && now - t >= -60000; };
  const isUpcoming = (c) => c && ["waiting", "designed", "upcoming"].includes(c.status);
  const inTab = (c, tab, now) => (tab === "live" ? isLive(c) : tab === "new" ? isNew(c, now) : tab === "upcoming" ? isUpcoming(c) : tab === "trending" ? isLive(c) : false);
  const counts = (cards, now) => Object.fromEntries(TABS.map((t) => [t, cards.filter((c) => inTab(c, t, now)).length]));

  const m = (c, k) => num(c && c.market && c.market[k]);
  const holders = (c) => num(c && c.holders && c.holders.count);
  const byName = (a, b) => str(a.ticker).localeCompare(str(b.ticker), "en") || str(a.name).localeCompare(str(b.name), "en");
  /** Descending by a number; cards without one go last; a tie is left to the next key. */
  const desc = (get) => (a, b) => { const x = get(a), y = get(b); if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1; return y - x; };
  /** Keys in turn; what is still tied is ordered by ticker, so the order is stable. */
  const order = (...cmps) => (a, b) => { for (const f of cmps) { const r = f(a, b); if (r) return r; } return byName(a, b); };
  const SORT_FN = {
    volume: order(desc((c) => m(c, "volume24hUsd"))),
    mcap: order(desc((c) => m(c, "marketCapUsd"))),
    liquidity: order(desc((c) => m(c, "liquidityUsd"))),
    holders: order(desc(holders)),
    newest: order(desc((c) => launchedMs(c) ?? designedMs(c))),
    change: order(desc((c) => m(c, "priceChange24hPct"))),
    name: byName,
  };
  const vicFirst = (a, b) => (b.kind === "vicinity") - (a.kind === "vicinity"); // the site's own token leads its list
  const DEFAULT_ORDER = {
    live: order(vicFirst, SORT_FN.newest), // $VICINITY has no recorded launch time: pinned first rather than sinking to the end
    new: SORT_FN.newest,
    upcoming: order(vicFirst, desc(designedMs)),
    trending: order(desc((c) => m(c, "volume24hUsd")), desc((c) => m(c, "priceChange24hPct")), desc(holders)),
  };
  /** The cards of one tab, in the tab's own order (or the chosen sort), after the search box and the filters. */
  function rowsFor(cards, { tab = "live", q = "", country = "", status = "", sort = "", now = Date.now(), countryNames = null } = {}) {
    if (!TABS.includes(tab)) tab = "live";
    const rows = (Array.isArray(cards) ? cards : []).filter((c) => c && inTab(c, tab, now)
      && (!country || (c.city && c.city.country === country))
      && (!status || c.status === status || (status === "designed" && c.status === "upcoming"))
      && matches(c, q, countryNames));
    return rows.sort(SORTS.includes(sort) ? SORT_FN[sort] : DEFAULT_ORDER[tab]);
  }

  /* ----- numbers: short on the card, the full value in the title ----- */
  const compactFmt = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
  const plainFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
  const centsFmt = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  /** A dollar amount people can read at a glance: $1.2M, $45.3K, $12.50, $0.0042, $0.0000012. */
  function money(v) {
    const n = num(v); if (n == null) return null;
    const a = Math.abs(n), sign = n < 0 ? "-" : "";
    if (a >= 1000) return `${sign}$${compactFmt.format(a)}`;
    if (a >= 1) return `${sign}$${centsFmt.format(a)}`;
    if (a === 0) return "$0";
    return `${sign}$${small(a, 3)}`; // three significant digits past the leading zeros: $0.0042, $0.000000123
  }
  /** The same amount in full, for the title: $1,234,567.89 (sub-dollar prices keep every meaningful digit). */
  function fullMoney(v) {
    const n = num(v); if (n == null) return null;
    const a = Math.abs(n), sign = n < 0 ? "-" : "";
    if (a >= 1 || a === 0) return `${sign}$${centsFmt.format(a)}`;
    return `${sign}$${small(a, 6)}`;
  }
  /** 0 < a < 1 with `sig` significant digits, never in exponent form, trailing zeros dropped (at least two decimals kept). */
  function small(a, sig) {
    const digits = Math.min(16, Math.max(2, -Math.floor(Math.log10(a)) - 1 + sig));
    return a.toFixed(digits).replace(/(\.\d\d\d*?)0+$/, "$1");
  }
  /** A count: 45.3K on the card, 45,312 in full. */
  const count = (v) => { const n = num(v); return n == null ? null : n >= 1000 ? compactFmt.format(n) : plainFmt.format(n); };
  const fullCount = (v) => { const n = num(v); return n == null ? null : plainFmt.format(n); };
  /** The community line and its title: "1 member · 1 holds $VICINITY", "3 members · 2 hold $VICINITY"; null without a member count. */
  function communityText(mem) {
    const n = num(mem && mem.members), h = num(mem && mem.holders);
    if (n == null) return null;
    const members = (c) => `${c} ${n === 1 ? "member" : "members"}`;
    const short = members(count(n)) + (h != null ? ` · ${count(h)} ${h === 1 ? "holds" : "hold"} $VICINITY` : "");
    const full = members(fullCount(n)) + (h != null ? `, ${fullCount(h)} ${h === 1 ? "who holds" : "of them hold"} $VICINITY` : "");
    return { short, full };
  }
  /** A 24-hour change: +12.3% / -4.1% (always signed, one decimal). */
  const pct = (v) => { const n = num(v); return n == null ? null : `${n > 0 ? "+" : n < 0 ? "-" : ""}${Math.abs(n).toFixed(1)}%`; };

  /* ----- time ----- */
  const pad2 = (n) => String(n).padStart(2, "0");
  /** "Opens in 3d 02h" style text for a time left in milliseconds; "Launching" once it has passed (the mint is still on its way). */
  function countdownText(ms) {
    if (!(ms > 0)) return "Launching";
    const d = Math.floor(ms / 86400000), h = Math.floor((ms % 86400000) / 3600000), mi = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000);
    return d > 0 ? `Opens in ${d}d ${pad2(h)}h` : h > 0 ? `Opens in ${h}h ${pad2(mi)}m` : `Opens in ${mi}m ${pad2(s)}s`;
  }
  /** How old the numbers are, in whole seconds: since they arrived, plus how old the server said they already were (if plausible). */
  function ageSeconds({ asOf, receivedAt, now }) {
    const server = Date.parse(asOf), lag = receivedAt - server;
    const already = Number.isFinite(server) && lag >= 0 && lag <= 120000 ? lag : 0;
    return Math.max(0, Math.round((now - receivedAt + already) / 1000));
  }
  const agoText = (s) => (!(s >= 0) ? "" : s < 5 ? "Updated just now" : s < 60 ? `Updated ${s} s ago` : s < 3600 ? `Updated ${Math.floor(s / 60)} min ago` : `Updated ${Math.floor(s / 3600)} h ago`);

  /* ----- words on a card ----- */
  const STATUS = { live: ["Live", "tag--ok"], waiting: ["Contract being checked", "tag--warn"], designed: ["Designed", ""], upcoming: ["Opens soon", "tag--gold"] };
  /** The status tag: text and extra class. $VICINITY before its mint carries the countdown. */
  function statusLabel(c, { now = Date.now(), opensAt = null } = {}) {
    if (c && c.status === "upcoming") { const at = Date.parse(str(c.opensAt)) || opensAt; return [Number.isFinite(at) ? countdownText(at - now) : "Opens soon", "tag--gold"]; }
    const s = STATUS[c && c.status] || ["Designed", ""];
    return s;
  }
  /** Why a coin cannot be bought yet, in plain words. */
  const notLiveWhy = (c) => (c && c.status === "waiting" ? "Trades once an admin records the contract." : c && c.kind === "vicinity" ? "Trades once $VICINITY launches on Raydium LaunchLab." : "Trades once the founder launches it on Raydium LaunchLab.");
  /** The founder line: the handle, or the masked wallet (never a full address, even if the server slipped). */
  function founderText(f) {
    if (!f || (!f.handle && !f.wallet)) return "No founder yet";
    const who = f.handle ? `@${str(f.handle).replace(/^@+/, "")}` : isAddr(f.wallet) ? `${f.wallet.slice(0, 5)}*****${f.wallet.slice(-3)}` : str(f.wallet);
    const role = f.status === "steward" ? "Seed Steward" : f.status === "provisional" ? "Founder (provisional)" : "Founder";
    return `${role} ✓ ${who}`;
  }
  const pairText = (c) => (c && c.pair && c.pair.symbol ? `Pair: $${str(c.ticker)} / ${str(c.pair.symbol)}` : c && c.kind === "vicinity" ? "Pair: $VICINITY / SOL" : "Pair: chosen by the founder");

  /* ----- links: the same templates as the dashboard and the token page; only these four sites, only for a real mint ----- */
  const HOSTS = { raydium: "https://raydium.io/", jupiter: "https://jup.ag/", dexscreener: "https://dexscreener.com/", solscan: "https://solscan.io/" };
  const safe = (u, key) => (typeof u === "string" && u.startsWith(HOSTS[key]) && !/[\s"'<>]/.test(u) ? u : null);
  function links(c) {
    const mint = c && isAddr(c.mint) ? c.mint : null;
    const given = (c && c.links) || {};
    if (!mint) return null;
    const quote = c.pair && isAddr(c.pair.mint) && c.pair.mint !== SOL_MINT ? c.pair.mint : "SOL";
    return {
      raydium: safe(given.raydium, "raydium") || `https://raydium.io/launchpad/token/?mint=${mint}`,
      jupiter: safe(given.jupiter, "jupiter") || `https://jup.ag/swap/${quote}-${mint}`,
      dexscreener: safe(given.dexscreener, "dexscreener") || `https://dexscreener.com/solana/${mint}`,
      solscan: safe(given.solscan, "solscan") || `https://solscan.io/token/${mint}`,
    };
  }
  const viewHref = (c) => (c && c.kind === "vicinity" ? "/token" : c && c.city && (typeof c.city.id === "number" || /^[A-Za-z0-9_-]{1,40}$/.test(str(c.city.id))) ? `/cities?city=${encodeURIComponent(c.city.id)}` : "/cities");
  const logoSrc = (c) => (c && /^\/api\/media\/[A-Za-z0-9_-]{1,64}$/.test(str(c.logo)) ? c.logo : null);
  const COLORS = ["gold", "rose", "ocean", "emerald", "violet", "ink"];
  const colorOf = (c) => (COLORS.includes(c && c.color) ? c.color : "gold");
  const cardKey = (c) => `${str(c.kind)}:${c.city && c.city.id != null ? c.city.id : str(c.ticker)}`;

  /* ----- the address bar: /launchpad?tab=trending&q=utica ----- */
  function stateFromUrl(search) {
    const p = new URLSearchParams(str(search));
    const tab = str(p.get("tab")).toLowerCase();
    return { tab: TABS.includes(tab) ? tab : "live", q: str(p.get("q")).slice(0, 60) };
  }
  function urlFor({ tab = "live", q = "" } = {}) {
    const p = new URLSearchParams();
    if (TABS.includes(tab) && tab !== "live") p.set("tab", tab);
    if (norm(q)) p.set("q", str(q).trim().slice(0, 60));
    const s = p.toString();
    return "/launchpad" + (s ? `?${s}` : "");
  }

  const pure = { NEW_DAYS, TABS, SORTS, TAB_NOTE, norm, searchText, matches, inTab, isNew, counts, rowsFor, money, fullMoney, count, fullCount, pct, communityText,
    countdownText, ageSeconds, agoText, statusLabel, notLiveWhy, founderText, pairText, links, viewHref, logoSrc, colorOf, cardKey, stateFromUrl, urlFor };
  window.VLaunchpad = { pure };
  if (typeof document === "undefined" || !window.V) return; // node: the helpers are enough

  /* =====================================================================
     The page
     ===================================================================== */
  const { $, $$, el, api, official, opensAt, reduced } = window.V;
  const sec = $("#lp-coins"); if (!sec) return;
  const REFRESH_MS = 30000, BACKOFF = [30000, 60000, 120000, 300000];
  let data = null, receivedAt = 0, fails = 0, timer = 0, state = { tab: "live", q: "", country: "", status: "", sort: "" }, countryNames = {}, started = false;

  const tabs = () => $$("#lp-tabs [role=tab]");
  const na = () => { const s = el("span", "lp-na"); s.title = "No data yet"; const dash = el("span", null, "—"); dash.setAttribute("aria-hidden", "true"); s.append(dash, el("span", "sr-only", "No data yet")); return s; };
  const val = (short, full) => { if (short == null) return na(); const s = el("span", "lp-val", short); if (full) s.title = full; return s; };
  const stat = (label, node, sub) => { const d = el("div", "lp-stat"); d.append(el("dt", null, label)); const dd = el("dd"); dd.append(node); if (sub) dd.append(sub); d.append(dd); return d; };
  const newTab = (a) => { a.target = "_blank"; a.rel = "noopener"; a.append(el("span", "sr-only", " (opens in a new tab)")); return a; };

  function card(c, now) {
    const li = el("li", "card lp-card"); li.dataset.key = cardKey(c); li.dataset.status = str(c.status);
    const head = el("div", "lp-card__head");
    const disc = el("div", "coin-disc lp-card__disc"); disc.dataset.color = colorOf(c);
    const logo = logoSrc(c);
    if (logo) { const img = el("img"); img.src = logo; img.alt = ""; img.width = 64; img.height = 64; img.loading = "lazy"; disc.append(img); }
    else { const tk = str(c.ticker).slice(0, 8); disc.dataset.len = String(Math.min(8, tk.length)); disc.append(el("span", null, tk)); } // longer tickers get smaller type
    disc.setAttribute("aria-hidden", "true");
    const id = el("div", "lp-card__id");
    const h3 = el("h3", "lp-card__title"); h3.append(el("span", "lp-card__ticker", `$${str(c.ticker)}`), " ", el("span", "lp-card__name", str(c.name)));
    const place = c.kind === "vicinity" ? "The Vicinity token · every city" : [c.city && c.city.name, countryNames[c.city && c.city.country] || (c.city && c.city.country)].filter(Boolean).join(", ");
    id.append(h3, el("p", "small muted lp-card__place", place));
    const [stText, stCls] = statusLabel(c, { now, opensAt: opensAt() });
    const tag = el("span", `tag ${stCls} lp-card__status`, stText); tag.dataset.status = str(c.status);
    head.append(disc, id, tag);

    const meta = el("p", "tiny muted lp-card__meta");
    meta.append(el("span", null, pairText(c)), el("span", "lp-card__sep", " · "), el("span", "lp-card__founder", c.kind === "vicinity" ? "Launched by the Vicinity team" : founderText(c.founder)));

    const dl = el("dl", "lp-stats");
    const mk = c.market || {};
    dl.append(stat("Price", val(money(mk.priceUsd), fullMoney(mk.priceUsd))));
    dl.append(stat("Market cap", val(money(mk.marketCapUsd), fullMoney(mk.marketCapUsd))));
    dl.append(stat("Liquidity", val(money(mk.liquidityUsd), fullMoney(mk.liquidityUsd))));
    const change = pct(mk.priceChange24hPct);
    const chg = change ? el("span", `lp-chg ${mk.priceChange24hPct > 0 ? "is-up" : mk.priceChange24hPct < 0 ? "is-down" : ""}`, ` ${change}`) : null;
    if (chg) chg.title = "Price change over 24 hours";
    dl.append(stat("24 h volume", val(money(mk.volume24hUsd), fullMoney(mk.volume24hUsd)), chg));
    dl.append(stat("Holders", val(count(holders(c)), fullCount(holders(c)))));
    const mem = c.members || {};
    const ct = communityText(mem);
    const community = ct ? el("span", "lp-val", ct.short) : na();
    if (ct) community.title = ct.full;
    dl.append(stat("Community", community));

    const acts = el("div", "lp-card__actions");
    const view = el("a", "btn btn--glass btn--sm", c.kind === "vicinity" ? "View $VICINITY" : "View"); view.href = viewHref(c); view.dataset.act = "view";
    if (c.kind !== "vicinity") view.setAttribute("aria-label", `View ${c.city && c.city.name ? c.city.name : str(c.name)}`);
    acts.append(view);
    const lk = isLive(c) ? links(c) : null;
    if (lk) {
      const buy = newTab(el("a", "btn btn--primary btn--sm", "Buy on Raydium ↗")); buy.href = lk.raydium; buy.dataset.act = "buy";
      const jup = newTab(el("a", "link-btn lp-card__alt", "or Jupiter ↗")); jup.href = lk.jupiter; jup.dataset.act = "jup";
      acts.append(buy, jup);
    } else {
      const wait = el("span", "lp-card__wait"); wait.append(el("span", "btn btn--glass btn--sm is-soft", "Not live yet"), el("span", "tiny muted", notLiveWhy(c)));
      wait.firstChild.setAttribute("aria-disabled", "true");
      acts.append(wait);
    }
    li.append(head, meta, dl, acts);
    return li;
  }

  /* ----- drawing ----- */
  function focusKey() {
    const a = document.activeElement, li = a && a.closest && a.closest(".lp-card");
    return li ? { key: li.dataset.key, act: a.dataset.act || "" } : null;
  }
  function render() {
    const now = Date.now(), cards = data ? [data.vicinity, ...(data.coins || [])].filter(Boolean) : [];
    const n = counts(cards, now);
    tabs().forEach((b) => { const on = b.dataset.tab === state.tab; b.setAttribute("aria-selected", String(on)); b.tabIndex = on ? 0 : -1; const c = b.querySelector("[data-count]"); if (c) c.textContent = String(n[b.dataset.tab] || 0); });
    $("#lp-panel").setAttribute("aria-labelledby", `lp-tab-${state.tab}`);
    $("#lp-tabnote").textContent = TAB_NOTE[state.tab];
    const rows = rowsFor(cards, { ...state, now, countryNames });
    const keep = focusKey();
    $("#lp-grid").replaceChildren(...rows.map((c) => card(c, now)));
    const empty = $("#lp-empty"), text = $("#lp-empty-text"), retry = $("#lp-retry");
    const filtered = norm(state.q) || state.country || state.status;
    if (!data && !fails) { text.textContent = "Loading city coins…"; retry.hidden = true; }
    else if (!data) { text.textContent = "Prices are loading. Try again in a moment."; retry.hidden = false; }
    else if (rows.length) { empty.hidden = true; }
    else if (filtered) { text.textContent = "Nothing matches. Try another word, or clear the filters."; retry.hidden = true; }
    else if (state.tab === "upcoming") { text.textContent = "No coin is waiting right now. A city's coin shows here as soon as its founder designs it."; retry.hidden = true; }
    else if (state.tab === "new") { text.textContent = `No coin went live in the last ${NEW_DAYS} days.`; retry.hidden = true; }
    else { text.textContent = "The first city coin appears here the moment its founder's contract is confirmed."; retry.hidden = true; }
    empty.hidden = Boolean(data && rows.length);
    $("#lp-count").textContent = data ? `${rows.length} ${rows.length === 1 ? "coin" : "coins"}${filtered ? " match" : ""}` : "";
    if (keep) { const again = $(`#lp-grid [data-key="${keep.key}"] [data-act="${keep.act}"]`); if (again) again.focus(); }
    paintAge();
  }
  function paintAge() {
    const u = $("#lp-updated"); if (!u) return;
    if (!data) { u.textContent = ""; return; }
    const s = ageSeconds({ asOf: data.asOf, receivedAt, now: Date.now() });
    u.textContent = `${agoText(s)}${fails ? " · Couldn't refresh, showing the last numbers." : ""}`;
  }
  function paintCountries() {
    const sel = $("#lp-country"), keep = state.country;
    const list = (data && Array.isArray(data.countries) ? data.countries : []).filter((x) => x && typeof x.code === "string").slice().sort((a, b) => str(a.name).localeCompare(str(b.name), "en"));
    countryNames = Object.fromEntries(list.map((x) => [x.code, str(x.name) || x.code]));
    sel.replaceChildren(el("option", null, "All countries"), ...list.map((x) => { const o = el("option", null, `${str(x.name) || x.code}${num(x.count) != null ? ` (${plainFmt.format(x.count)})` : ""}`); o.value = x.code; return o; }));
    sel.firstChild.value = "";
    sel.value = list.some((x) => x.code === keep) ? keep : "";
    state.country = sel.value;
  }
  /** After the opening (and only with the switch on): the hero and the phases speak of an open Launchpad. */
  function paintOpen(open) {
    if (!open) return;
    const hero = $(".launch-hero"); if (!hero) return;
    const kicker = $(".kicker", hero); if (kicker) kicker.textContent = "Vicinity Launchpad · open";
    const cta = $(".hero__cta .btn--primary", hero); if (cta) { cta.textContent = "Browse city coins ↓"; cta.href = "#lp-coins"; }
    const lead = $(".lead", hero);
    if (lead) for (const t of lead.childNodes) if (t.nodeType === 3 && /Opening\s*$/.test(t.nodeValue)) t.nodeValue = t.nodeValue.replace(/Opening\s*$/, "Opened ");
    const phases = $(".phases"), head = phases && phases.closest("section") && $(".section-head", phases.closest("section"));
    if (head) { const k = $(".kicker", head); if (k) k.textContent = "How it works"; const p = $("p.muted", head); if (p) p.textContent = "This was the order. The exact times were announced here before launch."; }
  }
  function paintSamples() {
    const note = $(".coin-stack p"); if (!note || !data) return;
    const live = [data.vicinity, ...(data.coins || [])].some((c) => c && c.status === "live");
    note.textContent = live ? "Sample tickers. The real coins are listed above." : "Sample tickers. Nothing is minted yet.";
  }

  /* ----- loading: one answer, refreshed every 30 s while the page is visible, slower after a failure ----- */
  async function load() {
    clearTimeout(timer);
    const d = await api("/api/launchpad");
    if (d && d.ok && Array.isArray(d.coins)) {
      data = d; receivedAt = Date.now(); fails = 0;
      paintCountries(); paintOpen(d.open === true || opensAt() <= Date.now()); paintSamples();
    } else {
      fails = Math.min(fails + 1, BACKOFF.length - 1);
    }
    render();
    schedule();
  }
  function schedule() {
    clearTimeout(timer);
    if (document.visibilityState === "hidden") return; // picks up again when the tab is looked at
    timer = setTimeout(load, fails ? BACKOFF[fails] : REFRESH_MS);
  }
  document.addEventListener("visibilitychange", () => {
    if (!started) return;
    if (document.visibilityState === "visible") { if (Date.now() - receivedAt >= REFRESH_MS) load(); else schedule(); }
    else clearTimeout(timer);
  });

  /* ----- controls ----- */
  function pushUrl() { try { history.replaceState(null, "", urlFor(state) + location.hash); } catch { /* an odd browser: the page still works */ } }
  function selectTab(tab, focus) {
    if (!TABS.includes(tab)) return;
    state.tab = tab; pushUrl(); render();
    if (focus) { const b = tabs().find((x) => x.dataset.tab === tab); if (b) b.focus(); }
  }
  function wire() {
    $("#lp-tabs").addEventListener("click", (e) => { const b = e.target.closest("[role=tab]"); if (b) selectTab(b.dataset.tab, false); });
    $("#lp-tabs").addEventListener("keydown", (e) => {
      const i = TABS.indexOf(state.tab); if (i < 0) return;
      const go = { ArrowRight: (i + 1) % TABS.length, ArrowLeft: (i + TABS.length - 1) % TABS.length, Home: 0, End: TABS.length - 1 }[e.key];
      if (go === undefined) return;
      e.preventDefault(); selectTab(TABS[go], true);
    });
    let t = 0;
    const q = $("#lp-q");
    q.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => { state.q = q.value; pushUrl(); render(); }, 120); });
    $("#lp-search").addEventListener("submit", (e) => { e.preventDefault(); clearTimeout(t); state.q = q.value; pushUrl(); render(); });
    for (const k of ["country", "status", "sort"]) $(`#lp-${k}`).addEventListener("change", (e) => { state[k] = e.target.value; render(); });
    $("#lp-retry").addEventListener("click", () => { fails = 0; load(); });
    // the $VICINITY card's "Opens in" tag and the "Updated" line keep time without redrawing the cards
    setInterval(() => {
      paintAge();
      const now = Date.now();
      $$('#lp-grid .lp-card__status[data-status="upcoming"]').forEach((tag) => { tag.textContent = countdownText(opensAt() - now); });
    }, reduced ? 10000 : 5000);
  }
  function start() {
    started = true;
    const fromUrl = stateFromUrl(location.search);
    state.tab = fromUrl.tab; state.q = fromUrl.q; $("#lp-q").value = fromUrl.q;
    wire();
    sec.hidden = false;
    render(); // the controls show at once; the first answer fills them
    load();
  }
  official.then((o) => { if (o && o.launchpadV2 === true) start(); });
})();
