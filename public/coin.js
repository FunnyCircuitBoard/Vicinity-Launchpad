// The coin page (/coin?mint=<mint>, LAUNCHPAD_V2=on): one coin listed on the Vicinity Launchpad ($VICINITY, or a city coin an admin
// recorded), from this site's own GET /api/coin and /api/coin/chart (src/coin.js). Nothing here talks to another site; the
// links to Raydium, Jupiter, GeckoTerminal / DEX Screener and Solscan are plain links people click.
// Honesty: every number says where it comes from, the answer's age is shown, a missing number is "—" with the server's reason,
// nothing is estimated here (the chart's market cap is price × the fixed 1,000,000,000, and it says so).
// Live: the numbers refresh every 30 s while the page is looked at (slower after a failure, never while the tab is hidden), and a
// new value eases through the site's motion layer (V.liveNums; a price never counts up from 0).
// An address that is not listed never reaches the page: the server answers 404 and the page says the coin is not listed, without
// repeating what was typed.
(() => {
  "use strict";

  /* =====================================================================
     Pure helpers (test/coin-ui.test.js runs them in node)
     ===================================================================== */
  const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  const isAddr = (a) => typeof a === "string" && ADDR_RE.test(a);
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const str = (v) => (typeof v === "string" ? v : "");
  const RANGES = ["1h", "24h", "7d", "30d", "all"], UNITS = ["USD", "SOL", "MCAP"], STYLES = ["line", "candles"];
  const RANGE_WORDS = { "1h": "1 hour", "24h": "24 hours", "7d": "7 days", "30d": "30 days", all: "all of its history" };
  const INTERVAL_WORDS = { "1m": "1-minute", "10m": "10-minute", "15m": "15-minute", "1h": "1-hour", "4h": "4-hour", "1d": "1-day" };
  const SUPPLY = 1_000_000_000;

  /** The mint in the address bar, or null (anything that is not an address is never used, never shown). */
  const mintFromUrl = (search) => { const m = new URLSearchParams(str(search)).get("mint"); return isAddr(m) ? m : null; };
  /** The chart's choices in the address bar: ?range=7d&unit=sol&style=candles (defaults left out). unit null = not chosen. */
  function chartFromUrl(search) {
    const p = new URLSearchParams(str(search));
    const range = str(p.get("range")).toLowerCase(), unit = str(p.get("unit")).toUpperCase(), style = str(p.get("style")).toLowerCase();
    const out = { range: RANGES.includes(range) ? range : "7d", unit: UNITS.includes(unit) ? unit : null, style: STYLES.includes(style) ? style : "line" };
    if (out.style === "candles") out.unit = "SOL"; // candles exist in SOL only (Raydium's)
    return out;
  }
  function urlFor(mint, { range = "7d", unit = null, style = "line" } = {}) {
    const p = new URLSearchParams();
    if (isAddr(mint)) p.set("mint", mint);
    if (RANGES.includes(range) && range !== "7d") p.set("range", range);
    if (UNITS.includes(unit)) p.set("unit", unit.toLowerCase());
    if (style === "candles") p.set("style", "candles");
    const s = p.toString();
    return "/coin" + (s ? `?${s}` : "");
  }
  /** What an answer of /api/coin means for the page: "ok" | "notfound" | "disabled" | "offline" | "error". */
  function stateOf(d) {
    if (d && d.ok === true && d.coin && typeof d.coin === "object" && isAddr(d.mint)) return "ok";
    const e = d && d.error;
    if (e === "unknown_coin" || e === "bad_mint") return "notfound";
    if (e === "not_enabled") return "disabled";
    if (e === "offline" || (d && d._status === 0)) return "offline";
    return "error";
  }

  /* ----- numbers ----- */
  const compactFmt = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });
  const centsFmt = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const intFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
  /** 0 < a < 1 with `sig` significant digits, never an exponent, trailing zeros dropped (two decimals kept). */
  function small(a, sig) {
    const digits = Math.min(20, Math.max(2, -Math.floor(Math.log10(a)) - 1 + sig));
    return a.toFixed(digits).replace(/(\.\d\d\d*?)0+$/, "$1");
  }
  /** A price, every digit that matters: $0.000007577, $1.25, $1,234.50. */
  function price(v, unit = "USD") {
    const n = num(v); if (n == null || n < 0) return null;
    const cur = unit === "SOL" ? "" : "$", tail = unit === "SOL" ? " SOL" : "";
    if (n === 0) return `${cur}0${tail}`;
    if (n >= 1) return `${cur}${centsFmt.format(n)}${tail}`;
    return `${cur}${small(n, 4)}${tail}`;
  }
  /** An amount at a glance: $7.58K, $1.2M, $12.50, $0.0042. */
  function money(v) {
    const n = num(v); if (n == null) return null;
    const a = Math.abs(n), sign = n < 0 ? "-" : "";
    if (a >= 1000) return `${sign}$${compactFmt.format(a)}`;
    if (a >= 1) return `${sign}$${centsFmt.format(a)}`;
    if (a === 0) return "$0";
    return `${sign}$${small(a, 3)}`;
  }
  /** "0.00000006234 SOL" → "0.0₇6234 SOL": the short form trading sites use, where the full one would not fit a tile (it stays in the title). */
  const shortZeros = (t) => str(t).replace(/^(\$?)0\.(0{4,})(\d+)/, (m, cur, z, rest) => `${cur}0.0${String(z.length).split("").map((d) => "₀₁₂₃₄₅₆₇₈₉"[Number(d)]).join("")}${rest}`);
  const fullMoney = (v) => { const n = num(v); return n == null ? null : n >= 1 || n === 0 ? `$${centsFmt.format(n)}` : `$${small(n, 6)}`; };
  const count = (v) => { const n = num(v); return n == null ? null : n >= 10000 ? compactFmt.format(n) : intFmt.format(n); };
  const tokens = (v) => { const n = num(v); return n == null ? null : n >= 1000 ? compactFmt.format(n) : n >= 1 ? centsFmt.format(n) : small(n, 3); };
  const sol = (v) => { const n = num(v); return n == null ? null : n >= 100 ? intFmt.format(n) : n >= 1 ? n.toFixed(2) : n.toFixed(4); };
  /** A 24-hour change for a chip: { text: "▲ 2.31%", cls: "is-up" }; nothing known: { text: "—", cls: "is-flat" }. */
  function chip(p, tail = "") {
    const n = num(p);
    if (n == null) return { text: `—${tail}`, cls: "is-flat" };
    const d = Math.abs(n) >= 100 ? 0 : Math.abs(n) >= 10 ? 1 : 2;
    return { text: `${n > 0 ? "▲ " : n < 0 ? "▼ " : ""}${Math.abs(n).toFixed(d)}%${tail}`, cls: n > 0 ? "is-up" : n < 0 ? "is-down" : "is-flat" };
  }
  /** "8 s ago", "3 min ago", "2 h ago", "4 days ago". */
  function ago(sec) {
    const s = num(sec); if (s == null || s < 0) return "";
    if (s < 5) return "just now";
    if (s < 60) return `${Math.floor(s)} s ago`;
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 172800) return `${Math.floor(s / 3600)} h ago`;
    return `${Math.floor(s / 86400)} days ago`;
  }
  /** How old the answer is, in seconds: since it arrived, plus what the server said it had already aged (if plausible). */
  function ageSeconds(asOf, receivedAt, now) {
    const server = Date.parse(str(asOf)), lag = receivedAt - server;
    const already = Number.isFinite(server) && lag >= 0 && lag <= 120000 ? lag : 0;
    return Math.max(0, Math.round((now - receivedAt + already) / 1000));
  }
  /** The first clause of a reason the server gave, as a sentence: "Jupiter has no price for it (no trade in the last 7 days)". */
  const firstReason = (r) => { const s = str(r).split(";")[0].trim(); return s ? s[0].toUpperCase() + s.slice(1) : ""; };
  const mask = (w) => (isAddr(w) ? `${w.slice(0, 5)}*****${w.slice(-3)}` : str(w));

  /**
   * The stat tiles from one answer: [{ key, label, value, title, src, sub, missing }]. A tile whose number is unknown keeps its
   * place: value null and the reason in `missing`.
   */
  function tilesOf(d) {
    const m = (d && d.market) || {}, s = m.sources || {}, why = m.missing || {}, f = d && d.facts, h = d && d.holders, smp = d && d.samples;
    const curve = m.curve || null, sym = str(m.nativeSymbol) || (curve && str(curve.symbol)) || "SOL";
    const tile = (key, label, value, { title = null, src = null, sub = null, missing = null } = {}) => ({ key, label, value, title, src, sub, missing: value == null ? missing || "No source has it right now" : null });
    const out = [];
    out.push(tile("price", "Price", price(m.priceUsd), { title: price(m.priceUsd), src: s.price || null, missing: firstReason(why.price) }));
    const ch = num(m.priceChange24hPct);
    out.push(tile("change", "24h change", ch == null ? null : chip(ch).text, { src: s.change24h || null, missing: firstReason(why.change24h) }));
    out.push(tile("mcap", "Market cap", money(m.marketCapUsd), { title: fullMoney(m.marketCapUsd), src: s.marketCap || null, missing: firstReason(why.marketCap) }));
    const same = num(m.fdvUsd) != null && num(m.marketCapUsd) != null && Math.abs(m.fdvUsd - m.marketCapUsd) <= Math.abs(m.marketCapUsd) * 1e-6;
    out.push(tile("fdv", "Fully diluted", money(m.fdvUsd), { title: fullMoney(m.fdvUsd), src: s.fdv || null, sub: same && f && f.mintingDisabled ? "= market cap: all of the supply exists" : null, missing: "Same sources as the market cap" }));
    if (m.liquidityKind === "bonding_curve") {
      const raised = curve && num(curve.raised) != null ? `${sol(curve.raised)} ${sym}` : null;
      out.push(tile("liq", "In the curve*", money(m.liquidityUsd), { title: `What the bonding curve holds${raised ? `: ${raised}` : ""}, valued at the ${sym} price. It is not a trading pool.`, src: s.liquidity || null, sub: raised, missing: firstReason(why.liquidity) }));
    } else out.push(tile("liq", "Liquidity", money(m.liquidityUsd), { title: fullMoney(m.liquidityUsd), src: s.liquidity || null, missing: firstReason(why.liquidity) }));
    out.push(tile("vol", "24h volume", money(m.volume24hUsd), { title: fullMoney(m.volume24hUsd), src: s.volume24h || null, missing: firstReason(why.volume24h) }));
    out.push(tile("traders", "24h traders", count(m.traders24h), { src: num(m.traders24h) != null ? s.volume24h || null : null, missing: "Only Jupiter counts them, and it gave no count" }));
    if (num(m.priceNative) != null) out.push(tile("native", `Price in ${sym}`, shortZeros(price(m.priceNative, "SOL")), { title: price(m.priceNative, "SOL"), src: "On-chain curve (Solana)", sub: `${sym} per ${str(d && d.coin && d.coin.ticker) ? "$" + d.coin.ticker : "token"}` }));
    const nc = smp && num(smp.change24hNativePct);
    if (smp && (nc != null || smp.since)) out.push(tile("change-native", `24h change in ${sym}`, nc == null ? null : chip(nc).text, { src: nc == null ? null : str(smp.source) || "vicinity.city samples", missing: smp.since ? "Needs 24 hours of readings in a row" : "Not recorded yet" }));
    out.push(tile("holders", "Holders", h && num(h.count) != null ? count(h.count) : null, { title: h && num(h.count) != null ? `${intFmt.format(h.count)} wallets` : null, src: h ? str(h.source) || "Counted by vicinity.city" : null, sub: null, missing: "Not counted yet: vicinity.city counts every 10 minutes" }));
    out.push(tile("supply", "Supply", f && num(f.supply) != null ? intFmt.format(f.supply) : null, { src: f ? str(f.source) : null, sub: f && f.mintingDisabled ? "Fixed: no one can mint more" : null, missing: "The chain could not be read" }));
    const auth = (on, held) => (on ? "Disabled ✓" : held ? "Held by the launch program" : "Enabled ⚠");
    out.push(tile("mintauth", "Mint authority", f ? auth(f.mintingDisabled, f.mintHeldByProgram) : null, { src: f ? str(f.source) : null, missing: "The chain could not be read" }));
    out.push(tile("freeze", "Freeze authority", f ? auth(f.freezingDisabled, false) : null, { src: f ? str(f.source) : null, missing: "The chain could not be read" }));
    return out;
  }

  /** The bonding curve in words: { pct, of, text, graduated } or null when the coin has no LaunchLab curve. */
  function curveOf(d) {
    const c = d && d.market && d.market.curve; if (!c || typeof c !== "object") return null;
    const sym = str(c.symbol) || "SOL", raised = num(c.raised), target = num(c.target), pct = num(c.progressPct);
    const ticker = d.coin && str(d.coin.ticker) ? `$${d.coin.ticker}` : "the coin";
    const graduated = c.stage !== "curve";
    return {
      graduated, value: graduated ? 100 : pct == null ? 0 : Math.max(0, Math.min(100, pct)),
      pct: graduated ? "Graduated" : pct == null ? "—" : `${pct >= 10 ? pct.toFixed(1) : pct.toFixed(2)}%`,
      of: !graduated && raised != null && target != null ? `${sol(raised)} of ${sol(target)} ${sym} raised` : "",
      text: graduated ? `${ticker} has moved to a Raydium pool and trades like any other token.`
        : `When ${target != null ? sol(target) : "the target"} ${sym} has been raised, ${ticker} moves to a Raydium pool and trades like any other token. Until then every buy and sell happens on the curve. (Raydium's own page shows a progress figure based on price, which reads lower.)`,
    };
  }
  /** The third trade tile: DEX Screener once it lists a pool; before that the curve's pool on GeckoTerminal; else nothing. */
  function thirdLink(d) {
    const l = (d && d.links) || {}, m = (d && d.market) || {};
    if (typeof l.dexscreener === "string" && /^https:\/\/dexscreener\.com\//.test(l.dexscreener)) return { name: "DEX Screener", href: l.dexscreener };
    const pool = m.curve && isAddr(m.curve.poolId) ? m.curve.poolId : null;
    return pool ? { name: "GeckoTerminal", href: `https://www.geckoterminal.com/solana/pools/${pool}` } : null;
  }
  /** Only links to the sites they name, for this coin's own address. */
  const safeLink = (u, host) => (typeof u === "string" && u.startsWith(`https://${host}/`) && !/[\s"'<>]/.test(u) ? u : null);
  /** One trade as two short lines. */
  function tradeView(t, nowMs, ticker) {
    if (!t || (t.side !== "buy" && t.side !== "sell") || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(str(t.txid))) return null;
    const at = Date.parse(str(t.at));
    return {
      side: t.side, sideText: t.side === "buy" ? "Buy" : "Sell",
      amount: sol(t.amount) != null ? `${sol(t.amount)} ${str(t.symbol) || "SOL"}` : "—",
      tokens: tokens(t.tokens) != null ? `${tokens(t.tokens)} ${ticker || ""}`.trim() : "",
      who: `${str(t.wallet) || "—"} · ${Number.isFinite(at) ? ago((nowMs - at) / 1000) : ""}`,
      href: `https://solscan.io/tx/${t.txid}`, key: t.txid,
    };
  }
  /** Which unit the chart opens in when the address bar does not say: USD once vicinity.city has a dozen readings in the range,
   *  else SOL (Raydium's candles go back to the launch), else USD. */
  function defaultUnit(chart) {
    const pts = chart && chart.line && Array.isArray(chart.line.points) ? chart.line.points.filter((p) => Array.isArray(p) && num(p[1]) != null).length : 0;
    const rows = chart && chart.candles && Array.isArray(chart.candles.rows) ? chart.candles.rows.length : 0;
    return pts >= 12 ? "USD" : rows >= 2 ? "SOL" : "USD";
  }
  /** The line under the chart: where the series comes from and what span it covers. */
  function chartFoot(series, range, dom, chart, tzName) {
    if (!series) return "";
    const iv = Object.keys(window.VChart ? window.VChart.pure.INTERVALS : {}).find((k) => window.VChart.pure.INTERVALS[k] === series.interval);
    const what = series.kind === "candles" ? `${INTERVAL_WORDS[iv] || ""} candles` : series.unit === "SOL" ? `${INTERVAL_WORDS[iv] || ""} candles as a line` : `a reading every ${iv === "10m" ? "10 minutes" : (INTERVAL_WORDS[iv] || "").replace(/-/, " ")}`;
    const parts = [], how = series.empty ? "" : `, ${what}`; // an empty range names no interval
    if (series.unit === "SOL") parts.push(`Price in SOL: Raydium LaunchLab (the curve's price after each trade)${how}`);
    else if (series.unit === "MCAP") parts.push(`Market cap = price × 1,000,000,000 (the supply is fixed: minting is disabled on the chain). Price: vicinity.city readings${how}`);
    else parts.push(`Price in USD: read by vicinity.city (Jupiter's last trade, or the on-chain curve × SOL)${how}`);
    if (series.unit !== "SOL" && chart && chart.line && chart.line.recordingSince) parts.push(`recorded since ${fmtDate(chart.line.recordingSince)}`);
    if (dom && dom.short) parts.push(`history in this range starts ${fmtDate(new Date(dom.x0 * 1000).toISOString())}`);
    parts.push(tzName ? `times in your time zone (${tzName})` : "times in your time zone");
    return parts.join(" · ");
  }
  const fmtDate = (iso) => { const t = Date.parse(str(iso)); return Number.isFinite(t) ? new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) : ""; };

  const pure = { isAddr, shortZeros, mintFromUrl, chartFromUrl, urlFor, stateOf, price, money, fullMoney, count, tokens, sol, chip, ago, ageSeconds, firstReason, mask, tilesOf, curveOf, thirdLink, safeLink, tradeView, defaultUnit, chartFoot, RANGES, UNITS, STYLES };
  window.VCoin = { pure };
  if (typeof document === "undefined" || !window.V || !window.VChart || !window.VChart.create) return; // node: the helpers are enough

  /* =====================================================================
     The page
     ===================================================================== */
  const V = window.V, { $, el, api, official, copy } = V;
  const root = $("#coin"); if (!root) return;
  const REFRESH_MS = 30000, BACKOFF = [30000, 60000, 120000, 300000], CHART_MS = 60000;
  let mint = mintFromUrl(location.search), data = null, receivedAt = 0, fails = 0, timer = 0, offi = null;
  const view = chartFromUrl(location.search);
  let unitChosen = view.unit != null; // the address bar (or the visitor) chose it; otherwise the first chart answer decides
  let unitDecided = unitChosen;
  const charts = new Map(); // tf -> { at, d }
  let chartLoad = 0, chartKey = "", seenTrades = null, holdersAt = 0, scrub = null, pillsKey = "";
  const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { return ""; } })();
  const newTab = (a) => { a.target = "_blank"; a.rel = "noopener"; a.append(el("span", "sr-only", " (opens in a new tab)")); return a; };
  const show = (sel, on) => { const e = $(sel); if (e) e.hidden = !on; return e; };
  /** Writes text only when it changed (the motion layer reads every write as a new value). */
  const put = (e, text) => { if (e && e.textContent !== text) e.textContent = text; return e; };

  /* ----- the note card (not listed, switched off, not launched, unreachable) ----- */
  function note(kind) {
    const T = {
      notfound: ["This coin isn't listed on Vicinity", "Only $VICINITY and the city coins recorded by Vicinity have a page here. Check the address, or find the coin on the Launchpad.", "/launchpad", "Back to the Launchpad", false],
      disabled: ["Coin pages aren't switched on yet", "The live chart and the trades are coming. Meanwhile, the token page shows $VICINITY's contract, holders and links.", "/token", "Go to the token page", false],
      prelaunch: ["$VICINITY isn't launched yet", "Its page opens here the moment the official contract is published. Anything called $VICINITY before that is fake.", "/token", "Go to the token page", false],
      offline: ["You seem to be offline", "The live numbers couldn't load. They'll come back by themselves when you're online.", "/launchpad", "Back to the Launchpad", true],
      error: ["The live numbers didn't load", "The coin's data source didn't answer. Trying again in 30 seconds.", "/launchpad", "Back to the Launchpad", true],
    }[kind];
    $("#coin-note-title").textContent = T[0]; $("#coin-note-text").textContent = T[1];
    const a = $("#coin-note-link"); a.href = T[2]; a.textContent = T[3];
    show("#coin-note-retry", T[4]);
    show("#coin-note", true); show("#coin-main", false); show("#coin-lower", false); show("#coin-sources", false);
    root.removeAttribute("aria-busy");
    document.title = `${T[0]} · Vicinity`;
  }

  /* ----- the header ----- */
  function paintHead(d, ageS) {
    const c = d.coin, m = d.market || {};
    const ticker = `$${str(c.ticker) || "COIN"}`;
    $("#coin-ticker").textContent = ticker; $("#coin-ticker").classList.remove("skel", "skel--w140");
    const place = c.kind === "vicinity" ? "Vicinity · Solana" : [c.city && c.city.name, c.city && c.city.country, "Solana"].filter(Boolean).join(" · ");
    $("#coin-name").textContent = c.kind === "vicinity" ? place : `${str(c.name)} · ${place}`;
    for (const id of ["#coin-disc", "#coin-mini-disc"]) {
      const disc = $(id); disc.dataset.color = ["gold", "rose", "ocean", "emerald", "violet", "ink"].includes(c.color) ? c.color : "gold";
      const logo = /^\/api\/media\/[A-Za-z0-9_-]{1,64}$/.test(str(c.logo)) ? c.logo : null;
      const old = disc.querySelector("img");
      if (logo && !old) { const img = el("img"); img.src = logo; img.alt = ""; img.width = 64; img.height = 64; disc.append(img); }
      disc.firstElementChild.textContent = logo ? "" : str(c.ticker).slice(0, 8);
      disc.dataset.len = String(Math.min(8, str(c.ticker).length));
    }
    $("#coin-mini-ticker").textContent = ticker;
    // pills: live, the curve or graduation, official
    const cv = curveOf(d), words = [];
    if (cv && !cv.graduated) words.push(["tag--gold", `Bonding curve ${cv.pct}`]);
    else if (cv && cv.graduated) words.push(["tag--gold", "✓ Graduated to Raydium"]);
    if (offi && offi.tokenContract === d.mint) words.push(["tag--ok", "✓ Official"]);
    else if (c.kind === "city") words.push(["", "City coin · recorded by Vicinity"]);
    const key = JSON.stringify(words);
    if (key !== pillsKey) { // redrawn only when something changed (the live dot keeps its rhythm)
      pillsKey = key;
      const live = el("span", "tag tag--ok coin-pill coin-live"); live.append(el("span", "coin-pill__dot"), "Live");
      $("#coin-pills").replaceChildren(live, ...words.map(([cls, text]) => el("span", `tag ${cls} coin-pill`, text)));
    }
    // the price (the chart's crosshair writes into its own copy while it is held, so the live one never jumps)
    paintPrice(d, ageS);
  }
  function paintPrice(d, ageS) {
    const m = d.market || {};
    const p = price(m.priceUsd), ch = chip(m.priceChange24hPct, " · 24h");
    put($("#coin-price"), p || "—");
    if (!scrub) {
      const c = $("#coin-chg"); put(c, ch.text); c.className = `coin-chg ${ch.cls}`;
      c.title = num(m.priceChange24hPct) == null ? `No 24-hour change: ${firstReason(m.missing && m.missing.change24h) || "no source has it"}` : `24-hour change · ${str(m.sources && m.sources.change24h)}`;
      const sub = [];
      if (p) {
        if (money(m.marketCapUsd)) sub.push(`Market cap ${money(m.marketCapUsd)}`);
        sub.push(str(m.sources && m.sources.price));
        sub.push(`updated ${ago(ageS)}`);
      } else sub.push(`No price right now: ${firstReason(m.missing && m.missing.price) || "no source has one"}`);
      put($("#coin-price-sub"), sub.filter(Boolean).join(" · "));
      $("#coin-price").title = p ? `${p} · ${str(m.sources && m.sources.price)}` : "No price right now";
    }
    put($("#coin-mini-price"), p || "—");
    const mc = $("#coin-mini-chg"); put(mc, ch.text.replace(" · 24h", "")); mc.className = `coin-chg ${ch.cls}`;
  }
  /** The crosshair is on a point: the price shows that value and the change since the range began. */
  function onScrub(pt) {
    scrub = pt;
    $("#coin-price-box").classList.toggle("is-scrub", Boolean(pt));
    show("#coin-price", !pt); show("#coin-price-scrub", Boolean(pt));
    if (!pt) { if (data) paintPrice(data, ageSeconds(data.asOf, receivedAt, Date.now())); $("#coin-chart-live").textContent = ""; return; }
    const unit = pt.series.unit;
    const val = unit === "SOL" ? price(pt.v, "SOL") : unit === "MCAP" ? `${money(pt.v)} market cap` : price(pt.v);
    $("#coin-price-scrub").textContent = val || "—";
    const since = window.VChart.pure.changePct(pt.series.first, pt.v), c = chip(since);
    const start = window.VChart.pure.fmtWhen(Math.floor((pt.series.kind === "candles" ? pt.series.candles[0][0] : pt.series.points[0][0])), 86400);
    const chg = $("#coin-chg"); chg.textContent = `${c.text} since ${start}`; chg.className = `coin-chg ${c.cls}`;
    const when = window.VChart.pure.fmtWhen(pt.t, pt.series.interval);
    const src = pt.series.unit === "SOL" ? "Raydium LaunchLab" : pt.src ? window.VChart.pure.SRC_WORDS[pt.src] : "vicinity.city reading";
    $("#coin-price-sub").textContent = `${when} · ${src} · let go for the live price`;
    $("#coin-chart-live").textContent = `${when}: ${val}`;
  }

  /* ----- the tiles ----- */
  function paintTiles(d, ageS) {
    const dl = $("#coin-tiles"), tiles = tilesOf(d), stale = Boolean(d.market && d.market.stale);
    show("#coin-stale", stale);
    const have = new Map([...dl.children].map((x) => [x.dataset.key, x]));
    const order = [];
    for (const t of tiles) {
      let box = have.get(t.key);
      if (!box) {
        box = el("div", "coin-tile"); box.dataset.key = t.key;
        const dd = el("dd"), v = el("span", "coin-tile__val");
        dd.append(v, el("span", "coin-tile__sub"), el("span", "coin-tile__src"));
        box.append(el("dt", null, t.label), dd);
        if (EASE.has(t.key)) V.liveNums([v]); // a new value eases from the old one; the fixed facts never move
      }
      box.querySelector("dt").textContent = t.label;
      const v = box.querySelector(".coin-tile__val"), sub = box.querySelector(".coin-tile__sub"), src = box.querySelector(".coin-tile__src");
      box.classList.toggle("is-na", t.value == null);
      box.classList.toggle("is-stale", stale && t.value != null);
      box.classList.toggle("is-up", t.key.startsWith("change") && /▲/.test(t.value || ""));
      box.classList.toggle("is-down", t.key.startsWith("change") && /▼/.test(t.value || ""));
      if (t.value == null) {
        put(v, "—"); v.title = t.missing; put(sub, "");
        put(src, t.missing);
      } else {
        put(v, t.value); v.title = [t.title, t.src].filter(Boolean).join(" · ");
        put(sub, t.sub || ""); put(src, t.src || "");
      }
      sub.hidden = !sub.textContent;
      order.push(box);
    }
    if (order.length !== dl.children.length || order.some((b, i) => dl.children[i] !== b)) dl.replaceChildren(...order);
    put($("#coin-tiles-age"), `Updated ${ago(ageS)}`);
  }
  const EASE = new Set(["price", "mcap", "fdv", "liq", "vol", "traders", "native", "holders"]);

  /* ----- the curve ----- */
  function paintCurve(d) {
    const cv = curveOf(d);
    show("#coin-curve", Boolean(cv));
    if (!cv) return;
    $("#coin-curve-pct").textContent = cv.pct;
    $("#coin-curve-of").textContent = cv.of;
    const bar = $("#coin-curve-bar"); bar.value = cv.value; bar.classList.toggle("is-done", cv.graduated);
    bar.setAttribute("aria-valuetext", cv.graduated ? "Graduated" : `${cv.pct}${cv.of ? `, ${cv.of}` : ""}`);
    $("#coin-curve-text").textContent = cv.text;
    $("#coin-curve-src").textContent = `Source: ${str(d.market.sources && d.market.sources.curve) || "Solana blockchain"}${d.market.curve && num(d.market.curve.slot) ? ` · slot ${intFmt.format(d.market.curve.slot)}` : ""}`;
  }

  /* ----- buy & sell, the contract ----- */
  function paintLinks(d) {
    const l = d.links || {};
    const set = (id, u) => { const a = $(id); if (u) { a.href = u; a.hidden = false; } else a.hidden = true; return a; };
    const ray = safeLink(l.raydium, "raydium.io");
    for (const id of ["#coin-lnk-raydium", "#coin-head-buy", "#coin-buybar-buy"]) set(id, ray);
    set("#coin-lnk-jup", safeLink(l.jupiter, "jup.ag"));
    const third = thirdLink(d);
    set("#coin-lnk-third", third && third.href);
    if (third) $("#coin-lnk-third-name").textContent = third.name;
    set("#coin-lnk-solscan", safeLink(l.solscan, "solscan.io"));
    $("#coin-ca-text").textContent = d.mint;
    show("#coin-ca-copy", true);
    const official = offi && offi.tokenContract === d.mint;
    show("#coin-ca-badge", official || d.coin.kind === "city");
    $("#coin-ca-badge-text").textContent = official ? "Official" : "Recorded by Vicinity";
    $("#coin-ca-badge").classList.toggle("is-plain", !official);
    $("#coin-ca-note").textContent = official ? "This is the only official $VICINITY. Anything else using the name is fake."
      : `The one ${d.coin.ticker ? "$" + d.coin.ticker : "coin"} an admin recorded for ${d.coin.city && d.coin.city.name ? d.coin.city.name : "this city"}. Check the address before you buy.`;
  }
  let copiedTimer = 0;
  async function copyMint() {
    if (!data) return;
    if (!(await copy(data.mint, "Contract address copied"))) return;
    const b = $("#coin-ca-copy"), label = $("#coin-ca-copy-label");
    b.classList.remove("is-copied"); void b.offsetWidth; b.classList.add("is-copied"); label.textContent = "Copied";
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => { b.classList.remove("is-copied"); label.textContent = "Copy address"; }, 1800);
  }

  /* ----- trades ----- */
  function paintTrades(d) {
    const tr = d.trades || {}, list = $("#coin-trades"), now = Date.now(), ticker = d.coin.ticker ? str(d.coin.ticker) : "";
    const rows = (Array.isArray(tr.rows) ? tr.rows : []).map((t) => tradeView(t, now, ticker)).filter(Boolean).slice(0, 20);
    const before = seenTrades;
    seenTrades = new Set(rows.map((r) => r.key));
    list.replaceChildren(...rows.map((r) => {
      const li = el("li", "coin-trade");
      if (before && !before.has(r.key)) li.classList.add("is-new");
      const a = newTab(el("a", `coin-trade__row is-${r.side}`)); a.href = r.href;
      const top = el("span", "coin-trade__top");
      top.append(el("span", `coin-tside coin-tside--${r.side}`, r.sideText), el("span", "coin-trade__amt", r.amount), el("span", "coin-trade__tok", r.tokens));
      a.prepend(top, el("span", "coin-trade__who", `${r.who} · Solscan ↗`));
      li.append(a);
      return li;
    }));
    const empty = rows.length ? "" : tr.missing ? firstReason(tr.missing) : "No trades yet";
    $("#coin-trades-n").textContent = rows.length ? `newest ${rows.length}` : "";
    const foot = $("#coin-trades-foot");
    foot.replaceChildren();
    if (empty) foot.append(el("strong", null, empty), ". ");
    if (tr.source) foot.append(`Trades: ${tr.source}${tr.note ? ` (${tr.note.toLowerCase()})` : ""}${tr.stale ? " · delayed" : ""}. `);
    const pool = safeLink(d.links && d.links.pool, "solscan.io");
    if (pool) { const a = newTab(el("a", "coin-foot__link", "Every trade on Solscan ↗")); a.href = pool; foot.append(a); }
  }

  /* ----- holders ----- */
  async function paintHolders(d) {
    const h = d.holders;
    put($("#coin-holders-n"), h && num(h.count) != null ? count(h.count) : "—");
    $("#coin-holders-word").textContent = h && h.count === 1 ? "holder" : "holders";
    const age = h && Date.parse(str(h.asOf));
    $("#coin-holders-src").textContent = h ? `${str(h.source) || "Counted by vicinity.city"}${Number.isFinite(age) ? ` · counted ${ago((Date.now() - age) / 1000)}` : ""}` : "Not counted yet: vicinity.city counts every 10 minutes.";
    const vic = d.coin.kind === "vicinity";
    const more = $("#coin-holders-more");
    if (vic) { more.href = "/token#holders"; more.textContent = "See every holder on the token page →"; more.removeAttribute("target"); }
    else { more.href = `https://solscan.io/token/${d.mint}#holders`; more.textContent = "Every holder on Solscan ↗"; more.target = "_blank"; more.rel = "noopener"; }
    if (!vic || Date.now() - holdersAt < 120000) return;
    holdersAt = Date.now();
    const r = await api("/api/holders");
    if (!r || !Array.isArray(r.holders) || r.mint !== d.mint) return;
    $("#coin-holders").replaceChildren(...r.holders.slice(0, 5).map((x) => {
      const li = el("li", "coin-holder");
      const who = el("span", "coin-holder__who"); who.append(el("span", "coin-holder__rank", x.rank ? `#${x.rank}` : "Pool"), " ", el("code", null, mask(x.owner)));
      if (x.label) who.append(" ", el("span", "tag coin-holder__tag", str(x.label)));
      const pct = num(x.percent);
      li.append(who, el("span", "coin-holder__pct", pct == null ? "—" : `${pct >= 10 ? pct.toFixed(1) : pct >= 0.01 ? pct.toFixed(2) : "<0.01"}%`));
      return li;
    }));
  }

  /* ----- about, sources ----- */
  function paintAbout(d) {
    const c = d.coin, f = d.facts, p = $("#coin-about-text");
    if (c.kind === "vicinity") {
      const facts = [];
      if (f && num(f.supply) != null) facts.push(`a fixed supply of ${intFmt.format(f.supply)}`);
      if (f && f.mintingDisabled && f.freezingDisabled) facts.push("mint and freeze authority disabled (checked on the chain)");
      const team = offi && Array.isArray(offi.teamWallets) && isAddr(offi.teamWallets[0]) ? ` (team wallet ${mask(offi.teamWallets[0])})` : "";
      const when = Date.parse(str(c.launchedAt));
      p.textContent = `$VICINITY is the key to the Vicinity map: hold it to found and back your city. One official token${facts.length ? `, ${facts.join(", ")}` : ""}. Launched on Raydium LaunchLab${Number.isFinite(when) ? ` on ${new Date(when).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" })}` : ""} by the Vicinity team${team}.`;
    } else {
      const city = c.city && c.city.name ? c.city.name : "its city";
      p.textContent = `${c.ticker ? "$" + c.ticker : "This coin"} is the one official coin of ${city}${c.city && c.city.country ? `, ${c.city.country}` : ""}: launched by its founder on Raydium LaunchLab, paired with ${c.pair && c.pair.symbol ? c.pair.symbol : "SOL"}, and recorded by Vicinity.`;
    }
    const links = $("#coin-about-links"), out = [];
    const a = (text, href, ext) => { const x = el("a", "chip-link coin-about__link", text); x.href = href; if (ext) newTab(x); return x; };
    if (c.kind === "city" && c.city && /^[A-Za-z0-9_-]{1,40}$/.test(str(c.city.id))) out.push(a(`${c.city.name || "The city"} on the map`, `/cities?city=${encodeURIComponent(c.city.id)}`));
    out.push(a("vicinity.city", "/"));
    const x = offi && Array.isArray(offi.socials) ? offi.socials.find((s) => /^@[A-Za-z0-9_]{1,15}$/.test(s)) : null;
    if (x) out.push(a(`X ${x}`, `https://x.com/${x.slice(1)}`, true));
    out.push(a("Rules", "/rules"), a("Token & holders", "/token"));
    links.replaceChildren(...out);
  }
  function paintSources(d) {
    const p = $("#coin-sources"), parts = [];
    for (const x of Array.isArray(d.attribution) ? d.attribution : []) {
      if (!x || typeof x.text !== "string") continue;
      const u = typeof x.url === "string" && /^https:\/\/(jup\.ag|raydium\.io|dexscreener\.com)(\/|$)/.test(x.url) && !/[\s"'<>]/.test(x.url) ? x.url : null;
      if (u) { const a = newTab(el("a", null, x.text)); a.href = u; parts.push(a); } else parts.push(el("span", null, x.text));
    }
    parts.push(el("span", null, "Price history in USD: read by vicinity.city every 10 minutes"));
    parts.push(el("span", null, "Not financial advice"));
    p.replaceChildren(...parts.flatMap((n, i) => (i ? [" · ", n] : [n])));
  }

  /* ----- the chart ----- */
  const chart = window.VChart.create($("#coin-canvas"), { onScrub });
  function chartMsg(text, { retry = false, alt = null, loading = false } = {}) {
    const st = $("#coin-chart-state");
    st.hidden = !text && !loading;
    show("#coin-chart-skel", loading);
    const m = show("#coin-chart-msg", Boolean(text)); if (text) m.textContent = text;
    show("#coin-chart-retry", retry);
    const b = show("#coin-chart-alt", Boolean(alt)); if (alt) { b.textContent = alt.text; b.onclick = alt.go; }
  }
  function paintControls() {
    for (const b of document.querySelectorAll("#coin-range button")) b.setAttribute("aria-pressed", String(b.dataset.range === view.range));
    for (const b of document.querySelectorAll("#coin-unit button")) b.setAttribute("aria-pressed", String(b.dataset.unit === view.unit));
    for (const b of document.querySelectorAll("#coin-style button")) b.setAttribute("aria-pressed", String(b.dataset.style === view.style));
  }
  function remember() { try { history.replaceState(null, "", urlFor(mintFromUrl(location.search) ? mint : null, { ...view, unit: unitChosen ? view.unit : null }) + location.hash); } catch { /* the page still works */ } }
  function drawChart(animate) {
    const hit = charts.get(view.range);
    if (!hit) return;
    const d = hit.d;
    if (!unitDecided) { view.unit = defaultUnit(d); unitDecided = true; paintControls(); }
    const supply = data && data.facts && data.facts.mintingDisabled && num(data.facts.supply) ? data.facts.supply : null;
    const s = window.VChart.pure.seriesFrom(d, { unit: view.unit, style: view.unit === "SOL" ? view.style : "line", supply: view.unit === "MCAP" ? supply : SUPPLY });
    if (s.empty) {
      chart.clear();
      const other = view.unit !== "SOL" ? window.VChart.pure.seriesFrom(d, { unit: "SOL" }) : null;
      chartMsg(`${s.empty}.`, { alt: other && !other.empty ? { text: "Show the SOL price (since launch)", go: () => setUnit("SOL") } : null });
      $("#coin-chart-foot").textContent = chartFoot(s, view.range, null, d, tz);
      $("#coin-legend").textContent = "";
      return;
    }
    chartMsg("");
    // a live update pings the last point only when it moved; the same answer drawn again stays still
    const lastT = s.kind === "candles" ? s.candles[s.candles.length - 1][0] : s.points[s.points.length - 1][0];
    const key = `${view.range}|${s.unit}|${s.kind}|${lastT}|${s.last}`;
    if (animate === "ping" && key === chartKey) animate = false;
    chartKey = key;
    const dom = chart.set(s, { range: view.range, nowSec: Math.floor(Date.now() / 1000), animate });
    $("#coin-chart-foot").textContent = chartFoot(s, view.range, dom, d, tz);
    const c = chip(window.VChart.pure.changePct(s.first, s.last));
    const leg = $("#coin-legend"); leg.className = `coin-chart__legend ${c.cls}`;
    leg.textContent = `${c.text} over ${dom && dom.short ? "the history shown" : RANGE_WORDS[view.range]}`;
    $("#coin-canvas").setAttribute("aria-label", `Price chart, ${RANGE_WORDS[view.range]}, ${s.unit === "MCAP" ? "market cap" : s.unit}: from ${window.VChart.pure.fmtValue(s.first, s.unit === "SOL" ? "SOL" : "USD")} to ${window.VChart.pure.fmtValue(s.last, s.unit === "SOL" ? "SOL" : "USD")} (${c.text}). Arrow keys read each point.`);
  }
  async function loadChart(animate, force) {
    const tf = view.range, hit = charts.get(tf);
    if (hit && !force && Date.now() - hit.at < CHART_MS) { drawChart(animate); return; }
    if (!hit) { chart.clear(); chartMsg("", { loading: true }); }
    const n = ++chartLoad;
    const d = await api(`/api/coin/chart?mint=${encodeURIComponent(mint)}&tf=${tf}`);
    if (n !== chartLoad) return; // another range was chosen meanwhile
    if (d && d.ok === true) { charts.set(tf, { at: Date.now(), d }); drawChart(hit ? (animate || "ping") : "reveal"); return; }
    if (hit) { drawChart(false); return; } // keep what was there; the next round tries again
    chart.clear();
    chartMsg("The chart's data didn't load. Retrying in 60 s.", { retry: true });
    setTimeout(() => { if (view.range === tf && !charts.has(tf)) loadChart("reveal", true); }, 60000);
  }
  function setUnit(u) {
    if (!UNITS.includes(u)) return;
    view.unit = u; unitChosen = true; unitDecided = true;
    if (u !== "SOL" && view.style === "candles") { view.style = "line"; $("#coin-chart-live").textContent = "Candles exist in SOL only: showing a line."; }
    paintControls(); remember(); drawChart("reveal");
  }
  function wireChart() {
    $("#coin-range").addEventListener("click", (e) => { const b = e.target.closest("button[data-range]"); if (!b || b.dataset.range === view.range) return; view.range = b.dataset.range; paintControls(); remember(); loadChart("reveal"); });
    $("#coin-unit").addEventListener("click", (e) => { const b = e.target.closest("button[data-unit]"); if (b && b.dataset.unit !== view.unit) setUnit(b.dataset.unit); });
    $("#coin-style").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-style]"); if (!b || b.dataset.style === view.style) return;
      view.style = b.dataset.style;
      if (view.style === "candles" && view.unit !== "SOL") { view.unit = "SOL"; unitChosen = true; unitDecided = true; $("#coin-chart-live").textContent = "Candles are in SOL: Raydium LaunchLab's own."; }
      paintControls(); remember(); drawChart("reveal");
    });
    $("#coin-chart-retry").addEventListener("click", () => loadChart("reveal", true));
  }

  /* ----- the slim header and the phone's Buy bar ----- */
  function wireBars() {
    const IO = window.IntersectionObserver; if (!IO) return;
    const mini = $("#coin-mini"), bar = $("#coin-buybar");
    let priceOut = false, headBuyOut = false, buyCardIn = false;
    const apply = () => {
      const m = priceOut && Boolean(data);
      mini.classList.toggle("is-on", m); mini.inert = !m; mini.setAttribute("aria-hidden", String(!m));
      const b = headBuyOut && !buyCardIn && Boolean(data) && !$("#coin-head-buy").hidden && window.matchMedia("(max-width: 1023px)").matches;
      bar.classList.toggle("is-on", b); bar.inert = !b;
      document.body.classList.toggle("has-coin-buybar", b);
    };
    const top = 66; // under the sticky site header
    new IO((es) => { for (const e of es) priceOut = !e.isIntersecting && e.boundingClientRect.top < top; apply(); }, { rootMargin: `-${top}px 0px 0px 0px` }).observe($("#coin-price-box"));
    new IO((es) => { for (const e of es) headBuyOut = !e.isIntersecting && e.boundingClientRect.top < top; apply(); }, { rootMargin: `-${top}px 0px 0px 0px` }).observe($("#coin-head-buy"));
    new IO((es) => { for (const e of es) buyCardIn = e.isIntersecting; apply(); }).observe($("#coin-buy"));
    window.addEventListener("resize", apply, { passive: true });
    $("#coin-buybar-copy").addEventListener("click", () => { if (data) copy(data.mint, "Contract address copied"); });
  }

  /* ----- loading: one answer every 30 s while the page is looked at ----- */
  async function load() {
    clearTimeout(timer);
    const d = await api(`/api/coin?mint=${encodeURIComponent(mint)}`);
    const st = stateOf(d);
    if (st === "ok") {
      data = d; receivedAt = Date.now(); fails = 0;
      if (d.mint !== mint) mint = d.mint;
      paint();
      loadChart(false);
    } else if (st === "notfound" || st === "disabled") { note(st); return; }
    else {
      fails = Math.min(fails + 1, BACKOFF.length - 1);
      if (!data) note(st);
      else $("#coin-price-sub").textContent = `Couldn't refresh: showing the numbers from ${ago(ageSeconds(data.asOf, receivedAt, Date.now()))}. Trying again soon.`;
    }
    schedule();
  }
  function paint() {
    const d = data, ageS = ageSeconds(d.asOf, receivedAt, Date.now());
    show("#coin-note", false); show("#coin-main", true); show("#coin-lower", true); show("#coin-sources", true);
    root.removeAttribute("aria-busy");
    document.title = `$${str(d.coin.ticker) || "Coin"}: live price, chart and holders · Vicinity`;
    paintHead(d, ageS); paintTiles(d, ageS); paintCurve(d); paintLinks(d); paintTrades(d); paintAbout(d); paintSources(d);
    paintHolders(d);
  }
  function schedule() {
    clearTimeout(timer);
    if (document.visibilityState === "hidden") return;
    timer = setTimeout(load, fails ? BACKOFF[fails] : REFRESH_MS);
  }
  document.addEventListener("visibilitychange", () => {
    if (!mint) return;
    if (document.visibilityState === "visible") { if (Date.now() - receivedAt >= REFRESH_MS) load(); else schedule(); }
    else clearTimeout(timer);
  });
  // the "updated N s ago" words keep time between answers without redrawing anything else
  setInterval(() => {
    if (!data || document.hidden) return;
    const ageS = ageSeconds(data.asOf, receivedAt, Date.now());
    paintPrice(data, ageS);
    put($("#coin-tiles-age"), `Updated ${ago(ageS)}`);
  }, 5000);

  /** /coin on its own is $VICINITY: its address comes from the site's own settings (/api/official). */
  async function begin(again) {
    if (!mint && new URLSearchParams(location.search).has("mint")) { note("notfound"); return; } // an address that is not one: never shown, never asked
    offi = again ? await api("/api/official") : await official;
    if (!mint) mint = offi && isAddr(offi.tokenContract) ? offi.tokenContract : null;
    if (!mint) { note(offi && offi.ok === false ? stateOf(offi) : "prelaunch"); return; }
    load();
  }
  paintControls();
  wireChart(); wireBars();
  V.liveNums([$("#coin-price"), $("#coin-mini-price"), $("#coin-holders-n")]);
  $("#coin-ca-copy").addEventListener("click", copyMint);
  $("#coin-note-retry").addEventListener("click", () => { fails = 0; if (mint && offi) load(); else begin(true); });
  begin(false);
})();
