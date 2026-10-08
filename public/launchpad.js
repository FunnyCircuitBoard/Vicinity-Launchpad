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
    // Only a real snapshot: one the job computed from the balance samples. The admin console's one-click test
    // snapshot (Merkle root "admin-manual", no holders) must never read as the Founding Supporter list.
    snap = (d.snapshots || []).find((s) => s.status !== "cancelled" && s.merkleRoot !== "admin-manual" && s.holders > 0) || null;
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
// Each live card (6 Oct 2026, the owner: "the $VICINITY coin does not have any real live data"): its price with the 24-hour change,
// a sparkline (GET /api/coin/chart, asked once the card is near the screen, at most every 5 minutes), market cap, 24-hour volume,
// holders, liquidity and its bonding curve, each with its source; the 30-second refresh updates the numbers in place (they ease,
// their cell flashes once) and the whole card opens the coin's own page, /coin?mint=<mint> (public/coin.js).
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

  /* ----- the live card: where it leads, the price line, the four numbers, the curve, the sparkline ----- */
  /** The whole card leads to the coin's own page (/coin) once it has a recorded mint; before that to its city, or the token page. */
  const coinHref = (c) => (isLive(c) && c && isAddr(c.mint) ? `/coin?mint=${c.mint}` : viewHref(c));
  /** The 24-hour change chip: "▲ 2.3% 24h" / "▼ 0.7% 24h" / "— 24h". */
  function chipOf(v) {
    const n = num(v);
    if (n == null) return { text: "— 24h", cls: "is-flat" };
    return { text: `${n > 0 ? "▲ " : n < 0 ? "▼ " : ""}${Math.abs(n).toFixed(Math.abs(n) >= 10 ? 1 : 2)}% 24h`, cls: n > 0 ? "is-up" : n < 0 ? "is-down" : "is-flat" };
  }
  /** The first clause of a reason the server gave, as a sentence. */
  const reason = (r) => { const s = str(r).split(";")[0].trim(); return s ? s[0].toUpperCase() + s.slice(1) : ""; };
  /** What the line under the price says: its source and the answer's age, or why there is no price. */
  function priceSource(mk, ageS) {
    const m = mk || {};
    if (num(m.priceUsd) == null) return `No price right now: ${reason(m.missing && m.missing.price) || "no source has one"}`;
    const age = !(ageS >= 0) ? "" : ageS < 5 ? "just now" : ageS < 60 ? `${ageS} s ago` : ageS < 3600 ? `${Math.floor(ageS / 60)} min ago` : `${Math.floor(ageS / 3600)} h ago`;
    return [str(m.sources && m.sources.price) || "Source not given", age].filter(Boolean).join(" · ");
  }
  /** A source in a word or two, for the line under a number on a card (the full label stays in the title and on the coin page). */
  function shortSource(label) {
    const t = str(label);
    if (!t) return "";
    if (/bonding curve/i.test(t)) return "Chain × Jupiter*";
    if (/^On-chain curve ×/.test(t)) return "Curve × Jupiter";
    if (/^Jupiter/.test(t)) return "Jupiter";
    if (/^Raydium/.test(t)) return "Raydium";
    if (/^DEX Screener/.test(t)) return "DEX Screener";
    if (/^Price × on-chain supply/.test(t)) return "Price × supply";
    if (/^Counted by vicinity\.city/.test(t)) return "vicinity.city";
    return t;
  }
  /**
   * The four numbers of a live card: Market cap · 24h volume · Holders · Liquidity (on a curve: what the curve holds, "In the curve*",
   * the same words as the coin page). Each cell carries, on screen, its source in a word or two (`src`) or why it is "—" (`why`);
   * a phone shows no tooltip, so nothing that matters lives only in the title. `foot`: the line that explains the star.
   */
  function statCells(c) {
    const m = (c && c.market) || {}, src = m.sources || {}, why = m.missing || {}, h = holders(c);
    const cell = (key, label, v, short, full, from, missing, note) => ({ key, label, v, value: short, src: short == null ? null : shortSource(from) || null, why: short == null ? missing : null,
      title: short == null ? missing : [full, from].filter(Boolean).join(" · ") + (note ? `. ${note}` : "") });
    const curve = m.liquidityKind === "bonding_curve";
    return [
      cell("mcap", "Market cap", num(m.marketCapUsd), money(m.marketCapUsd), fullMoney(m.marketCapUsd), src.marketCap, reason(why.marketCap) || "No source has it right now"),
      cell("vol", "24h volume", num(m.volume24hUsd), money(m.volume24hUsd), fullMoney(m.volume24hUsd), src.volume24h, reason(why.volume24h) || "No source has it right now"),
      cell("holders", "Holders", h, count(h), fullCount(h), h != null ? "Counted by vicinity.city (pools and team wallets excluded)" : null, "Not counted yet: vicinity.city counts every 10 minutes"),
      cell("liq", curve ? "In the curve*" : "Liquidity", num(m.liquidityUsd), money(m.liquidityUsd), fullMoney(m.liquidityUsd), src.liquidity, reason(why.liquidity) || "No source has it right now",
        curve ? "On the bonding curve this is what the curve holds, not a trading pool" : null),
    ];
  }
  /** Under a curve card's numbers: what the star means, on screen. */
  const curveFoot = (c) => {
    const m = (c && c.market) || {}, sym = str(m.curve && m.curve.symbol) || str(m.nativeSymbol) || "SOL";
    return m.liquidityKind === "bonding_curve" ? `* In the curve: the ${sym} the bonding curve holds (on-chain) × the ${sym} price (Jupiter). It is not a trading pool.` : null;
  };
  /** The bonding curve on a card: { pct, value, text, graduated } or null (no LaunchLab curve known). */
  function curveView(c) {
    const cv = c && c.market && c.market.curve;
    if (!cv || typeof cv !== "object") return null;
    const sym = str(cv.symbol) || "SOL", raised = num(cv.raised), target = num(cv.target), p = num(cv.progressPct);
    const amount = (v) => (v >= 100 ? plainFmt.format(v) : v.toFixed(2));
    if (cv.stage !== "curve") return { graduated: true, value: 100, pct: "Graduated", text: "Graduated to a Raydium pool · Solana chain" };
    return {
      graduated: false, value: p == null ? 0 : Math.max(0, Math.min(100, p)), pct: p == null ? "—" : `${p >= 10 ? p.toFixed(1) : p.toFixed(2)}%`,
      text: `${raised != null && target != null ? `${amount(raised)} of ${amount(target)} ${sym} raised · ` : ""}moves to a Raydium pool at ${target != null ? amount(target) : "its target"} ${sym} · Solana chain`,
    };
  }
  /** The line under a live coin's name: "Raydium LaunchLab · SOL pair" only when the chain found its LaunchLab pool or Jupiter says it
   *  launched there (server: market.launchpad); otherwise the pair alone, never a venue nobody confirmed. */
  function venueLine(c) {
    const m = (c && c.market) || {}, sym = str(c && c.pair && c.pair.symbol) || "SOL";
    return `${m.launchpad === "raydium-launchlab" || (m.curve && typeof m.curve === "object") ? "Raydium LaunchLab · " : ""}${sym} pair`;
  }
  /** Is it a card that trades (a price block, a curve, a sparkline) or one that waits? Cards of another shape are redrawn whole. */
  const shapeOf = (c) => [str(c && c.status), isLive(c) ? "live" : "wait", curveView(c) ? (curveView(c).graduated ? "grad" : "curve") : "nocurve"].join("|");

  /**
   * The sparkline of one /api/coin/chart answer: vicinity.city's USD readings when there are at least `min` of them, else
   * Raydium's SOL candles (between two trades the curve's price stays where the last one left it, so the line runs flat to now),
   * else whatever has two points. { points: [[t, v]], unit, from, to } or null (nothing to draw).
   */
  function sparkPick(answer, nowSec, min = 6) {
    const a = answer && answer.ok === true ? answer : null;
    if (!a) return null;
    const usd = (a.line && Array.isArray(a.line.points) ? a.line.points : []).filter((p) => Array.isArray(p) && Number.isSafeInteger(p[0]) && num(p[1]) != null && p[1] > 0).map((p) => [p[0], p[1]]);
    const rows = (a.candles && Array.isArray(a.candles.rows) ? a.candles.rows : []).filter((r) => Array.isArray(r) && Number.isSafeInteger(r[0]) && num(r[1]) > 0 && num(r[4]) > 0);
    const iv = { "1m": 60, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 }[a.candles && a.candles.interval] || 900;
    const solPts = [];
    for (const r of rows) { solPts.push([r[0], r[1]], [r[0] + iv, r[4]]); }
    if (solPts.length && solPts[solPts.length - 1][0] < nowSec) solPts.push([nowSec, solPts[solPts.length - 1][1]]);
    const pick = usd.length >= min ? [usd, "USD"] : rows.length * 2 >= min ? [solPts, "SOL"] : usd.length >= 2 ? [usd, "USD"] : solPts.length >= 2 ? [solPts, "SOL"] : null;
    if (!pick) return null;
    const pts = pick[0].slice().sort((x, y) => x[0] - y[0]);
    return { points: pts, unit: pick[1], from: pts[0][0], to: Math.max(nowSec, pts[pts.length - 1][0]) };
  }
  /** The sparkline's shape in a w × h box: a polyline, the area under it, where the line ends, and which way it went. */
  function sparkGeometry(spark, w = 240, h = 44, pad = 4) {
    const pts = spark && Array.isArray(spark.points) ? spark.points : [];
    if (pts.length < 2) return null;
    let lo = Infinity, hi = -Infinity;
    for (const [, v] of pts) { if (v < lo) lo = v; if (v > hi) hi = v; }
    const t0 = spark.from, t1 = Math.max(spark.to, t0 + 1);
    const X = (t) => Math.round(((t - t0) / (t1 - t0)) * w * 10) / 10;
    const Y = (v) => Math.round((hi === lo ? h / 2 : pad + (1 - (v - lo) / (hi - lo)) * (h - 2 * pad)) * 10) / 10;
    const xy = pts.map(([t, v]) => `${X(t)},${Y(v)}`);
    const first = pts[0][1], last = pts[pts.length - 1][1];
    return { line: xy.join(" "), area: `M${X(pts[0][0])},${h} L${xy.join(" L")} L${X(pts[pts.length - 1][0])},${h} Z`, endX: X(pts[pts.length - 1][0]), endY: Y(last),
      dir: last > first ? "up" : last < first ? "down" : "flat", sig: `${pts.length}:${pts[0][0]}:${pts[pts.length - 1][0]}:${last}` };
  }
  /**
   * Why a card has no sparkline, in words that stay true: "No trades in 7 days" only when Raydium's candles of a known curve say
   * so; otherwise nothing is recorded yet (vicinity.city reads the price every 10 minutes from the day a coin is live), or the
   * chart did not answer.
   */
  function sparkWhy(answer) {
    if (!answer || answer.ok !== true) return "Price history didn't load";
    const c = answer.candles;
    if (c && typeof c === "object" && Array.isArray(c.rows) && !c.rows.length && !(answer.line && Array.isArray(answer.line.points) && answer.line.points.length)) return "No trades in 7 days";
    return "No price history recorded yet";
  }
  /** The corner label: "24h · USD", or how far back the line goes when the history is shorter ("5h · SOL"). */
  function sparkLabel(spark, range) {
    if (!spark) return "";
    const span = spark.to - spark.from, full = range === "7d" ? 7 * 86400 : 86400;
    const words = span >= full * 0.95 ? range : span >= 2 * 86400 ? `${Math.round(span / 86400)}d` : `${Math.max(1, Math.round(span / 3600))}h`;
    return `${words} · ${spark.unit}`;
  }

  const pure = { NEW_DAYS, TABS, SORTS, TAB_NOTE, norm, searchText, matches, inTab, isNew, counts, rowsFor, money, fullMoney, count, fullCount, pct, communityText,
    countdownText, ageSeconds, agoText, statusLabel, notLiveWhy, founderText, pairText, links, viewHref, logoSrc, colorOf, cardKey, stateFromUrl, urlFor,
    coinHref, chipOf, priceSource, shortSource, statCells, curveFoot, curveView, venueLine, shapeOf, sparkPick, sparkGeometry, sparkLabel, sparkWhy };
  window.VLaunchpad = { pure };
  if (typeof document === "undefined" || !window.V) return; // node: the helpers are enough

  /* =====================================================================
     The page
     ===================================================================== */
  const { $, $$, el, api, official, opensAt, reduced } = window.V;
  const sec = $("#lp-coins"); if (!sec) return;
  const REFRESH_MS = 30000, BACKOFF = [30000, 60000, 120000, 300000];
  const SPARK_MS = 300000; // a sparkline is asked again at most every 5 minutes
  let data = null, receivedAt = 0, fails = 0, timer = 0, state = { tab: "live", q: "", country: "", status: "", sort: "" }, countryNames = {}, started = false;
  const sparks = new Map(); // mint -> { at, spark, range } (null spark: nothing to draw), refreshed every 5 minutes
  let gradients = 0;

  const tabs = () => $$("#lp-tabs [role=tab]");
  const na = (why = "No data yet") => { const s = el("span", "lp-na"); s.title = why; const dash = el("span", null, "—"); dash.setAttribute("aria-hidden", "true"); s.append(dash, el("span", "sr-only", why)); return s; };
  const newTab = (a) => { a.target = "_blank"; a.rel = "noopener"; a.append(el("span", "sr-only", " (opens in a new tab)")); return a; };
  const svg = (tag, attrs) => { const e = document.createElementNS("http://www.w3.org/2000/svg", tag); for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v); return e; };
  /** A field the 30-second refresh can update in place (data-f), with its number (data-v) to tell up from down. */
  const field = (e, f, v) => { e.dataset.f = f; if (v != null) e.dataset.v = String(v); return e; };

  /* ----- the sparkline: a line and the area under it, a dot where it ends; dashed and said in words when there is nothing ----- */
  function sparkEl(c, featured) {
    const h = featured ? 120 : 44, box = field(el("div", `lp-spark${featured ? " lp-spark--lg" : ""}`), "spark");
    box.setAttribute("aria-hidden", "true");
    if (!isLive(c)) {
      box.classList.add("is-empty"); box.dataset.sig = "wait";
      box.append(el("span", "lp-spark__dash"), el("span", "lp-spark__msg", "Not trading yet. Nothing is minted."));
      return box;
    }
    const hit = sparks.get(c.mint);
    if (!hit) { box.classList.add("is-loading"); box.dataset.sig = "loading"; box.dataset.mint = c.mint; return box; }
    const g = sparkGeometry(hit.spark, 240, h);
    if (!g) {
      box.classList.add("is-empty"); box.dataset.sig = `none:${hit.why}`;
      box.append(el("span", "lp-spark__dash"), el("span", "lp-spark__msg", hit.why || "No price history recorded yet"));
      return box;
    }
    box.classList.add(`is-${g.dir}`); box.dataset.sig = g.sig;
    const id = `lpg-${++gradients}`;
    const s = svg("svg", { class: "lp-spark__svg", viewBox: `0 0 240 ${h}`, preserveAspectRatio: "none", focusable: "false" });
    const grad = svg("linearGradient", { id, x1: "0", y1: "0", x2: "0", y2: "1" });
    grad.append(svg("stop", { offset: "0", class: "lp-spark__stop0" }), svg("stop", { offset: "1", class: "lp-spark__stop1" }));
    const defs = svg("defs"); defs.append(grad);
    s.append(defs, svg("path", { class: "lp-spark__area", d: g.area, fill: `url(#${id})` }), svg("polyline", { class: "lp-spark__line", points: g.line, "vector-effect": "non-scaling-stroke" }));
    // the end dot sits on the right edge (the line runs to now), drawn 1:1 so it stays round however wide the card is
    const end = svg("svg", { class: "lp-spark__end", viewBox: `0 0 20 ${h}`, focusable: "false" });
    end.append(svg("circle", { class: "lp-spark__ping", cx: "10", cy: String(g.endY), r: "3" }), svg("circle", { class: "lp-spark__dot", cx: "10", cy: String(g.endY), r: "3" }));
    box.append(s, end, el("span", "lp-spark__label", sparkLabel(hit.spark, hit.range)));
    return box;
  }
  /** Sparklines are asked for only once their card comes near the screen, at most every 5 minutes per coin. */
  const sparkIO = window.IntersectionObserver ? new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) { sparkIO.unobserve(e.target); fetchSpark(e.target.dataset.mint); } }, { rootMargin: "200px 0px" }) : null;
  const asking = new Set();
  async function fetchSpark(mint) {
    if (!isAddr(mint) || asking.has(mint)) return;
    const hit = sparks.get(mint); if (hit && Date.now() - hit.at < SPARK_MS) { paintSpark(mint); return; }
    asking.add(mint);
    const nowSec = Math.floor(Date.now() / 1000);
    const day = await api(`/api/coin/chart?mint=${encodeURIComponent(mint)}&tf=24h`);
    let range = "24h", spark = sparkPick(day, nowSec), why = null;
    if (!spark || spark.points.length < 6) { // a quiet day: the week tells more
      const weekAnswer = await api(`/api/coin/chart?mint=${encodeURIComponent(mint)}&tf=7d`);
      const week = sparkPick(weekAnswer, nowSec);
      if (week && (!spark || week.points.length > spark.points.length)) { spark = week; range = "7d"; }
      if (!spark) why = sparkWhy(weekAnswer && weekAnswer.ok === true ? weekAnswer : day);
    }
    asking.delete(mint);
    // a chart that did not answer is asked again at the next refresh, not in 5 minutes
    sparks.set(mint, { at: spark || (why && why !== "Price history didn't load") ? Date.now() : Date.now() - SPARK_MS + REFRESH_MS, spark, range, why });
    paintSpark(mint);
  }
  function paintSpark(mint) {
    for (const li of $$(`.lp-card[data-mint="${mint}"]`)) {
      const old = li.querySelector('[data-f="spark"]'); if (!old) continue;
      const c = cardsByKey.get(li.dataset.key); if (!c) continue;
      const fresh = sparkEl(c, li.classList.contains("lp-card--featured"));
      if (old.dataset.sig !== fresh.dataset.sig) old.replaceWith(fresh); // redrawn without animation
    }
  }
  function wantSparks(root) {
    for (const box of root.querySelectorAll('.lp-spark.is-loading[data-mint]')) {
      const hit = sparks.get(box.dataset.mint);
      if (hit && Date.now() - hit.at < SPARK_MS) continue;
      if (sparkIO) sparkIO.observe(box); else fetchSpark(box.dataset.mint);
    }
    // a drawn sparkline older than 5 minutes is asked again when its card is redrawn
    for (const li of root.querySelectorAll(".lp-card[data-mint]")) { const hit = sparks.get(li.dataset.mint); if (hit && Date.now() - hit.at >= SPARK_MS) fetchSpark(li.dataset.mint); }
  }

  /* ----- a card ----- */
  const cardsByKey = new Map(); // card key -> its latest data (a sparkline that arrives later is drawn from it)
  function card(c, now, featured) {
    const live = isLive(c);
    const li = el("li", `card lp-card${live ? " lp-card--live" : ""}${featured ? " lp-card--featured" : ""}`); li.dataset.key = cardKey(c); li.dataset.status = str(c.status); li.dataset.shape = shapeOf(c);
    if (live && isAddr(c.mint)) li.dataset.mint = c.mint;
    cardsByKey.set(cardKey(c), c);
    const head = el("div", "lp-card__head");
    const disc = el("div", "coin-disc lp-card__disc"); disc.dataset.color = colorOf(c);
    const logo = logoSrc(c);
    if (logo) { const img = el("img"); img.src = logo; img.alt = ""; img.width = 64; img.height = 64; img.loading = "lazy"; disc.append(img); }
    else { const tk = str(c.ticker).slice(0, 8); disc.dataset.len = String(Math.min(8, tk.length)); disc.append(el("span", null, tk)); } // longer tickers get smaller type
    disc.setAttribute("aria-hidden", "true");
    const id = el("div", "lp-card__id");
    // the title is the card's one link: its ::after covers the whole card, so a tap anywhere opens the coin (the buttons sit above it)
    const h3 = el("h3", "lp-card__title"), link = el("a", "lp-card__link"); link.href = coinHref(c); link.dataset.act = "view";
    link.append(el("span", "lp-card__ticker", `$${str(c.ticker)}`), " ", el("span", "lp-card__name", str(c.name)));
    if (live) link.append(el("span", "sr-only", ": chart and details"));
    h3.append(link);
    const place = c.kind === "vicinity" ? "The Vicinity token · every city" : [c.city && c.city.name, countryNames[c.city && c.city.country] || (c.city && c.city.country)].filter(Boolean).join(", ");
    id.append(h3, el("p", "small muted lp-card__place", place));
    if (live) id.append(field(el("p", "lp-card__sub", venueLine(c)), "venue"));
    const [stText, stCls] = statusLabel(c, { now, opensAt: opensAt() });
    const tag = field(el("span", `tag ${stCls} lp-card__status`), "status"); tag.dataset.status = str(c.status);
    if (live) tag.append(el("span", "lp-card__ping"), stText); else tag.textContent = stText;
    head.append(disc, id, tag);
    li.append(head);

    if (live) {
      const mk = c.market || {}, ch = chipOf(mk.priceChange24hPct);
      const box = el("div", `lp-price${mk.stale ? " is-stale" : ""}`);
      const row = el("p", "lp-price__row");
      const p = money(mk.priceUsd);
      const val = field(el("span", "lp-price__val lp-num", p || "—"), "price", num(mk.priceUsd));
      val.title = p ? `${fullMoney(mk.priceUsd)} · ${str(mk.sources && mk.sources.price)}` : priceSource(mk, 0);
      const chg = field(el("span", `lp-chg2 ${ch.cls}`, ch.text), "chg");
      chg.title = num(mk.priceChange24hPct) == null ? `No 24-hour change: ${reason(mk.missing && mk.missing.change24h) || "no source has it"}` : `24-hour change · ${str(mk.sources && mk.sources.change24h)}`;
      row.append(val, chg);
      const delayed = field(el("span", "tag tag--gold lp-delayed", "Delayed"), "delayed"); delayed.hidden = !mk.stale; delayed.title = "A source answered with its last good copy (at most a few minutes old)";
      row.append(delayed);
      box.append(row, field(el("p", "lp-src", priceSource(mk, ageSeconds({ asOf: data && data.asOf, receivedAt, now: Date.now() }))), "src"));
      li.append(box, sparkEl(c, featured));
      const dl = el("dl", "lp-stats lp-stats--live");
      for (const s of statCells(c)) {
        const d = el("div", "lp-stat"); d.dataset.cell = s.key;
        const dd = field(el("dd"), `s-${s.key}`, s.v); dd.title = s.title || "";
        dd.append(s.value == null ? na(s.title) : el("span", "lp-val lp-num", s.value));
        // its source, or why it is "—", on screen (a phone has no tooltip)
        const note = field(el("dd", `lp-stat__src${s.value == null ? " is-why" : ""}`, s.value == null ? s.why : s.src || ""), `n-${s.key}`);
        d.append(el("dt", null, s.label), dd, note);
        dl.append(d);
      }
      li.append(dl);
      const foot = curveFoot(c);
      if (foot) li.append(field(el("p", "lp-src lp-stats__foot", foot), "stats-foot"));
      const cv = curveView(c);
      if (cv) {
        const cb = el("div", `lp-curve${cv.graduated ? " is-done" : ""}`);
        const top = el("p", "lp-curve__row");
        top.append(el("span", null, cv.graduated ? "✓ Graduated to Raydium" : "Bonding curve"), field(el("strong", "lp-curve__pct", cv.graduated ? "100%" : cv.pct), "curve-pct", cv.value));
        const bar = field(el("progress", "lp-bar"), "curve-bar"); bar.max = 100; bar.value = cv.value; bar.setAttribute("aria-label", `Bonding curve ${cv.pct}`);
        cb.append(top, bar, field(el("p", "lp-src", cv.text), "curve-src"));
        li.append(cb);
      }
    } else li.append(sparkEl(c, featured));

    const meta = field(el("p", "tiny muted lp-card__meta"), "meta");
    meta.append(el("span", null, pairText(c)), el("span", "lp-card__sep", " · "), el("span", "lp-card__founder", c.kind === "vicinity" ? "Launched by the Vicinity team" : founderText(c.founder)));
    const ct = communityText(c.members || {});
    if (ct) { const com = el("span", "lp-card__community", ct.short); com.title = ct.full; meta.append(el("span", "lp-card__sep", " · "), com); }
    li.append(meta);

    const acts = el("div", "lp-card__actions");
    const lk = live ? links(c) : null;
    if (lk) {
      const buy = newTab(el("a", "btn btn--primary btn--sm", "Buy on Raydium ↗")); buy.href = lk.raydium; buy.dataset.act = "buy";
      const more = el("a", "btn btn--glass btn--sm", "Chart & details →"); more.href = coinHref(c); more.dataset.act = "chart";
      more.setAttribute("aria-label", `Chart and details of $${str(c.ticker)}`);
      acts.append(buy, more);
    } else {
      const wait = el("span", "lp-card__wait"); wait.append(el("span", "btn btn--glass btn--sm is-soft", "Not live yet"), el("span", "tiny muted", notLiveWhy(c)));
      wait.firstChild.setAttribute("aria-disabled", "true");
      acts.append(wait);
    }
    li.append(acts);
    return li;
  }
  /**
   * The 30-second refresh updates a card in place: each field (data-f) that changed gets its new words, so a new number eases
   * from the old one (the site's motion layer) and its cell flashes up or down once. A card of another shape is drawn anew.
   */
  function morph(old, fresh) {
    if (old.dataset.shape !== fresh.dataset.shape) return fresh; // (its classes are not compared: the motion layer adds its own)
    const ob = old.querySelector(".lp-price"), nb = fresh.querySelector(".lp-price");
    if (ob && nb) ob.classList.toggle("is-stale", nb.classList.contains("is-stale"));
    for (const n of old.querySelectorAll("[data-f]")) {
      const m = fresh.querySelector(`[data-f="${n.dataset.f}"]`);
      if (!m) continue;
      if (n.dataset.f === "spark") { if (n.dataset.sig !== m.dataset.sig) n.replaceWith(m); continue; }
      if (n.tagName === "PROGRESS") { if (n.value !== m.value) n.value = m.value; n.setAttribute("aria-label", m.getAttribute("aria-label")); continue; }
      if (n.className !== m.className) n.className = m.className;
      if (n.title !== m.title) n.title = m.title;
      if (n.hidden !== m.hidden) n.hidden = m.hidden;
      const a = Number(n.dataset.v), b = Number(m.dataset.v);
      if (m.dataset.v !== undefined) n.dataset.v = m.dataset.v;
      if (n.textContent === m.textContent) continue;
      const leaf = n.firstElementChild && m.firstElementChild && n.childElementCount === 1 && m.childElementCount === 1 && n.firstElementChild.className === m.firstElementChild.className && !n.firstElementChild.childElementCount;
      if (leaf) n.firstElementChild.textContent = m.firstElementChild.textContent; // the number itself: the motion layer eases it
      else if (!n.childElementCount && !m.childElementCount) n.textContent = m.textContent;
      else n.replaceChildren(...m.childNodes);
      if (Number.isFinite(a) && Number.isFinite(b) && a !== b && n.dataset.v !== undefined) flash(n.closest(".lp-stat, .lp-price") || n, b > a ? "up" : "down");
    }
    return old;
  }
  function flash(e, dir) {
    if (reduced) return;
    e.classList.remove("is-flash-up", "is-flash-down"); void e.offsetWidth;
    e.classList.add(`is-flash-${dir}`);
    setTimeout(() => e.classList.remove(`is-flash-${dir}`), 1000);
  }
  /** Puts these cards in the list, reusing the ones already there (same key, same shape). */
  function place(list, rows, now, featured) {
    const have = new Map([...list.children].map((li) => [li.dataset.key, li]));
    const next = rows.map((c) => { const fresh = card(c, now, featured), old = have.get(cardKey(c)); return old ? morph(old, fresh) : fresh; });
    if (next.length !== list.children.length || next.some((li, i) => list.children[i] !== li)) list.replaceChildren(...next);
    window.V.liveNums(list.querySelectorAll(".lp-num")); // numbers it already follows are left as they are
    wantSparks(list);
  }

  /* ----- drawing ----- */
  function focusKey() {
    const a = document.activeElement, li = a && a.closest && a.closest(".lp-card");
    return li ? { key: li.dataset.key, act: a.dataset.act || "", featured: li.classList.contains("lp-card--featured") } : null;
  }
  function render() {
    const now = Date.now(), cards = data ? [data.vicinity, ...(data.coins || [])].filter(Boolean) : [];
    const n = counts(cards, now);
    tabs().forEach((b) => { const on = b.dataset.tab === state.tab; b.setAttribute("aria-selected", String(on)); b.tabIndex = on ? 0 : -1; const c = b.querySelector("[data-count]"); if (c) c.textContent = String(n[b.dataset.tab] || 0); });
    $("#lp-panel").setAttribute("aria-labelledby", `lp-tab-${state.tab}`);
    $("#lp-tabnote").textContent = TAB_NOTE[state.tab];
    const rows = rowsFor(cards, { ...state, now, countryNames });
    const keep = focusKey();
    // "Live now": the Vicinity token on top, the same card a little larger (on a phone it is the same card)
    const vic = data && data.vicinity && isLive(data.vicinity) ? data.vicinity : null;
    place($("#lp-featured"), vic ? [vic] : [], now, true);
    $("#lp-featured").classList.toggle("is-on", Boolean(vic));
    place($("#lp-grid"), rows, now, false);
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
    if (keep) { const again = $(`${keep.featured ? "#lp-featured" : "#lp-grid"} [data-key="${keep.key}"] [data-act="${keep.act}"]`); if (again && again !== document.activeElement) again.focus(); }
    paintAge();
    paintSources();
  }
  function paintAge() {
    const u = $("#lp-updated"); if (!u) return;
    if (!data) { u.textContent = ""; return; }
    const s = ageSeconds({ asOf: data.asOf, receivedAt, now: Date.now() });
    u.textContent = `${agoText(s)}${fails ? " · Couldn't refresh, showing the last numbers." : ""}`;
    // each live card's price line says how old its numbers are
    for (const li of $$(".lp-card--live")) {
      const c = cardsByKey.get(li.dataset.key), src = li.querySelector('.lp-price [data-f="src"]');
      if (c && src) { const t = priceSource(c.market, s); if (src.textContent !== t) src.textContent = t; }
    }
  }
  /** The line under the list: the sources this answer used (Jupiter's terms ask for "Powered by Jupiter" wherever its data shows). */
  function paintSources() {
    const p = $("#lp-honesty"); if (!p || !data || !Array.isArray(data.attribution) || !data.attribution.length) return;
    const parts = [];
    for (const x of data.attribution) {
      if (!x || typeof x.text !== "string") continue;
      const u = typeof x.url === "string" && /^https:\/\/(jup\.ag|raydium\.io|dexscreener\.com)(\/|$)/.test(x.url) && !/[\s"'<>]/.test(x.url) ? x.url : null;
      if (u) { const a = newTab(el("a", null, x.text)); a.href = u; parts.push(a); } else parts.push(el("span", null, x.text));
    }
    const words = parts.flatMap((n, i) => (i ? [" · ", n] : [n]));
    p.replaceChildren(...words, ". Every card refreshes every 30 seconds and says how old its numbers are. You trade in your own wallet on Raydium or Jupiter; Vicinity never touches your funds.");
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
    // a live card opens its coin page wherever it is clicked (its title is the link the keyboard reaches); its own buttons and links
    // do what they say, and selecting a number to copy it is not a click
    sec.addEventListener("click", (e) => {
      if (e.button !== 0 || e.defaultPrevented) return;
      const li = e.target.closest && e.target.closest(".lp-card--live");
      if (!li || e.target.closest("a, button, input, select, label, summary")) return;
      if (window.getSelection && String(window.getSelection()) !== "") return;
      const a = li.querySelector(".lp-card__title a"); if (!a) return;
      if (e.metaKey || e.ctrlKey) window.open(a.href, "_blank", "noopener"); else location.assign(a.href);
    });
    // the $VICINITY card's "Opens in" tag and the "Updated" lines keep time without redrawing the cards
    setInterval(() => {
      if (document.hidden) return;
      paintAge();
      const now = Date.now();
      $$('.lp-card__status[data-status="upcoming"]').forEach((tag) => { tag.textContent = countdownText(opensAt() - now); });
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
