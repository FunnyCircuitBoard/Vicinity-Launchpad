// Vicinity: shared by every page. Header account button, toasts, scroll reveals, small helpers.
// No trackers, no outside requests: everything talks to this site's own /api.
(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  // less motion: the device asks for it (prefers-reduced-motion). The footer's "Pause animations" is gone (design v4: nothing loops), so
  // theme.js never sets data-motion any more and the second half of this test is always false; it stays for the pages that still read it.
  const reducedNow = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.dataset.motion === "paused";
  const reduced = reducedNow();
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const fmt = (n, max = 0) => Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: n > 0 && n < 1 ? 6 : max });
  const compact = (n) => Number(n || 0).toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 1 });
  const mask = (a) => (a && a.length > 10 ? `${a.slice(0, 5)}*****${a.slice(-3)}` : a || "");
  const short = (a) => (a && a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a || "");
  const ago = (iso) => { const s = Math.max(1, (Date.now() - Date.parse(iso)) / 1000); return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`; };
  const isAddr = (a) => typeof a === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);
  const initials = (name) => (String(name || "V").replace(/^@/, "").match(/[\p{L}\p{N}]/u) || ["V"])[0].toUpperCase();

  // "Open app" on a phone opened /connect?link=CODE inside a wallet app's browser: a one-time code that links the wallet there to
  // the account that made it (connect.js, the wallet link). The old sign-up's /connect?carry=CODE is read the same way for a week
  // (such a link is now only a calm line). The code leaves the address bar before anything else runs or asks the server (no
  // history entry or Referer keeps it); connect.js redeems it through takeLink() / takeCarry(), once. A pairing (/connect?pair=)
  // stays in the address bar (it is what the wallet app opened).
  // A link code this tab KEPT (sessionStorage, written by signup.js while its screen is up, for an hour at most) is read the same
  // way when the address bar holds none: a reload inside the wallet app (pull-to-refresh) offers the same link again, and never
  // the sign-up (the owner's rule: nothing asks for a location or Google at the wallet stage).
  const LINK_KEY = "vicinity-link";
  const keptLink = () => {
    try {
      const k = JSON.parse(sessionStorage.getItem(LINK_KEY) || "null");
      if (k && typeof k.code === "string" && /^[A-Za-z0-9_-]{32,64}$/.test(k.code) && Date.now() - Number(k.at) < 60 * 60_000) return k.code;
      if (k) sessionStorage.removeItem(LINK_KEY);
    } catch { /* storage blocked: a reload is an ordinary visit */ }
    return null;
  };
  let carryCode = null, linkCode = null;
  try {
    if (document.body.dataset.page === "connect") {
      const q = new URLSearchParams(location.search);
      const tidy = q.has("link") || q.has("carry");
      if (q.has("link")) { linkCode = q.get("link") || ""; q.delete("link"); }
      if (q.has("carry")) { carryCode = q.get("carry") || ""; q.delete("carry"); }
      // only a reload of the bare page (the code already left the address bar) shows the kept code again; anything else in the address
      // bar is a new intent ("Sign in with Phantom", a pairing, Log in) and the kept code is forgotten: it never hides what was asked for
      if (linkCode === null && carryCode === null) { if (!String(q)) linkCode = keptLink(); else try { sessionStorage.removeItem(LINK_KEY); } catch { /* blocked: nothing kept */ } }
      if (tidy) history.replaceState(history.state, "", location.pathname + (String(q) ? `?${q}` : "") + location.hash);
      // a phone opening a link code: the sign-up's hero never flashes before the question (onboard.css hides it until signup.js decides)
      if (linkCode !== null) document.documentElement.classList.add("has-link");
    }
  } catch { /* no address bar to tidy (tests) */ }
  const takeCarry = () => { const c = carryCode; carryCode = null; return c; };
  const takeLink = () => { const c = linkCode; linkCode = null; return c; };

  /** One short line in the toast (role=status: read out once). With `detail` (a contract address, a link, an amount the clipboard
   *  refused) the text sits on its own selectable line under the words, and the toast stays up long enough to copy it by hand.
   *  body.has-toast is set while it shows (feedback.css tucks the feedback button away meanwhile). */
  const toast = (msg, detail) => {
    const t = $("#toast"); if (!t) return;
    if (detail == null) t.textContent = msg;
    else { const d = el("span", "toast__detail", String(detail)); t.replaceChildren(document.createTextNode(msg), d); }
    t.hidden = false; document.body.classList.add("has-toast");
    clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; document.body.classList.remove("has-toast"); }, detail == null ? 3000 : 9000);
  };
  /** A small celebration at (x, y) (a sign-up, a check-in, a buy that landed): eight accent dots spread out and fade in 600 ms (style.css
   *  .burst; transform and opacity only). Nothing with reduced motion. */
  const burst = (x, y) => {
    if (reducedNow()) return;
    for (let i = 0; i < 8; i++) {
      const s = el("span", "burst");
      s.setAttribute("aria-hidden", "true");
      s.style.left = `${x}px`; s.style.top = `${y}px`;
      const a = (i / 8) * Math.PI * 2 + Math.random() * 0.4, d = 28 + Math.random() * 26;
      s.style.setProperty("--bx", `${(Math.cos(a) * d).toFixed(1)}px`); s.style.setProperty("--by", `${(Math.sin(a) * d).toFixed(1)}px`);
      document.body.append(s); setTimeout(() => s.remove(), 650);
    }
  };
  /** Copies text and says so in the toast; answers true when it reached the clipboard (false: the toast shows the text on a line of
   *  its own, to select and copy by hand: neutral words, since callers copy contract addresses, links, invites and amounts alike). */
  const copy = async (text, label = "Copied") => { try { await navigator.clipboard.writeText(text); toast(label); return true; } catch { toast("Couldn't copy. Select it here:", text); return false; } };

  /** JSON from our own API. POSTs send JSON; errors come back as { ok:false, error } (never throws on HTTP status). */
  async function api(path, body, method) {
    const init = { cache: "no-store", credentials: "same-origin" };
    if (body !== undefined || method) { init.method = method || "POST"; init.headers = { "content-type": "application/json" }; init.body = JSON.stringify(body || {}); }
    try {
      const r = await fetch(path, init);
      const d = await r.json().catch(() => ({}));
      if (!r.ok && d.ok === undefined) d.ok = false;
      d._status = r.status;
      return d;
    } catch { return { ok: false, error: "offline", _status: 0 }; }
  }

  /**
   * Inside a wallet app's own browser (a "WebView") rather than Safari / Chrome? Android WebViews say "wv", iPhone apps
   * leave out "Safari/", and some wallets put their name in the user agent. These browsers often can't share GPS with a
   * page, and Google refuses to sign people in inside them.
   */
  const ua = navigator.userAgent;
  const isPhone = /Android|iPhone|iPad|iPod/i.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua));
  const webView = (/Android/i.test(ua) && /; wv\)|\bwv\b/.test(ua)) || (/iPhone|iPad|iPod/i.test(ua) && !/Safari\//.test(ua)) ||
    (isPhone && /Phantom|Solflare|Backpack|OKX|TokenPocket|Trust\/|Coinbase|Bitget|BitKeep|MetaMask|imToken|Binance|Exodus/i.test(ua));

  /**
   * The wallet app this person uses ON THIS PHONE (owner decision F4: on phones people live inside the wallet app). Pages that need it
   * (signup.js, connect.js, dashboard.js; the Buy panel reads the same key) go through here once wallets.js has set window.VW.
   *   remember(id)  keeps a public/wallets.js KNOWN id in localStorage "vicinity.walletApp" (a convenience for this browser, never state)
   *   remembered()  that KNOWN entry, or null
   *   here()        the KNOWN entry of the wallet app whose OWN browser this is: a phone with a known wallet on the page, or a wallet app
   *                 that names itself in the user agent. null in Safari / Chrome, on a computer, and in Instagram's or Facebook's browser
   *                 (a web view, but no wallet: those must keep the ordinary sign-up, not "Sign in with your wallet")
   */
  const WALLET_APP = "vicinity.walletApp";
  const knownApp = (id) => (window.VW && typeof id === "string" && window.VW.KNOWN.find((k) => k.id === id)) || null;
  const walletApp = {
    remember(id) { if (knownApp(id)) { try { localStorage.setItem(WALLET_APP, id); } catch { /* private mode: the page asks again next time */ } } },
    remembered() { let id = null; try { id = localStorage.getItem(WALLET_APP); } catch { /* ignore */ } return knownApp(id); },
    here() {
      const W = window.VW;
      if (!W || !W.isMobile) return null;
      for (const a of W.list()) { const k = W.knownFor(a.name); if (k) return k; }
      return webView ? W.KNOWN.find((k) => k.open && k.match.test(ua)) || null : null;
    },
  };

  /**
   * The person's position, once. Rejects with an Error whose .code is "unsupported" | "denied" | "timeout" | "unavailable"
   * and whose .inApp says whether this is a wallet app's browser (pages then offer to finish in the phone's browser).
   * GPS first; if it doesn't answer, a network-based position (the server accepts anything within 20 km).
   */
  const LOCATION_GIVE_UP_MS = 40000; // both tries (12 s + 15 s) plus time to answer the browser's question
  function getLocation() {
    const fail = (code) => {
      const text = {
        unsupported: webView ? "This wallet app's browser can't share your location." : "Your browser can't share location.",
        denied: webView ? "This wallet app's browser isn't allowing location." : "Location is blocked. Allow location for this site in your browser settings, then try again.",
        timeout: "Couldn't get your location. Turn on location (GPS) and try again.",
        unavailable: "Couldn't get your location. Turn on location (GPS) and try again.",
      }[code];
      return Object.assign(new Error(text), { code, inApp: webView });
    };
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(fail("unsupported"));
      // Some wallet apps' browsers never answer at all (no prompt, no error): the page must not wait forever on "Checking your location…".
      let over = false;
      const guard = setTimeout(() => { over = true; reject(fail("timeout")); }, LOCATION_GIVE_UP_MS);
      const settle = (f) => (x) => { if (!over) { over = true; clearTimeout(guard); f(x); } };
      const ok = settle((p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: Math.round(p.coords.accuracy || 0) }));
      const no = settle(reject);
      const why = (e) => (e && e.code === 1 ? "denied" : e && e.code === 3 ? "timeout" : "unavailable");
      navigator.geolocation.getCurrentPosition(ok, (e) => {
        if (over) return;
        if (e && e.code === 1) return no(fail("denied"));
        navigator.geolocation.getCurrentPosition(ok, (e2) => no(fail(why(e2))), { enableHighAccuracy: false, timeout: 15000, maximumAge: 30000 });
      }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 });
    });
  }

  /* ---------- motion: blocks that rise in, numbers that count ---------- */
  /* motion: start (test/motion.test.js runs this part on a pretend page) */
  // One motion layer for every page. It never changes what a visitor can already see or what they read once it settles:
  // * blocks (cards, section heads, stats) still BELOW the screen when the page starts are lowered and faded (style.css .mo-armed)
  //   and rise in, a few at a time, as they scroll into view; blocks a page script adds later do the same. A block on screen at
  //   the start, a hidden one, and every block without this script, without IntersectionObserver or with reduced motion just shows.
  //   The keyboard never lands on something unseen: a block holding the focus is never lowered, and one that receives it (Tab, or
  //   a page script's focus()) shows at once.
  // * live numbers count up the first time they are on screen, and ease to a new value when the page's own script writes one
  //   (with a short glow). What is left when a count ends is the script's own text, word for word; anything that is not a plain
  //   number ("—", "Oct 10", "4d 18h", "<0.01%") is never touched. A count finishes at once when the tab is hidden.
  //   A number the browser has already drawn (this script is deferred: on a slow phone connection the page is painted first) is
  //   never reset to count up again, a price ($) or a rank (#) never counts up from 0 (it would show prices and ranks that never
  //   were), and a fixed fact marked data-still (the token's supply) is never touched.
  // * nothing loops (design v4, 12 Oct 2026): a live dot pings three times and rests, and no button glows or shines by itself, so there is
  //   nothing to pause off screen and no "Pause animations" switch (WCAG 2.2.2: every motion that starts by itself ends within 5 s).
  // No loop runs when nothing moves: a count asks for animation frames only while it lasts (1.3 s at most).
  const NUM = /^([$#]?)(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?([KMBT]?)(%|\+|×| [a-z][a-z ]*)?$/;
  const UNIT = { "": 1, K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
  const numFormats = new Map(); // one formatter per (decimals, grouping): a count writes up to 60 numbers a second
  const numFormat = (min, max, group) => {
    const k = `${min}-${max}-${group}`;
    if (!numFormats.has(k)) numFormats.set(k, new Intl.NumberFormat("en-US", { minimumFractionDigits: min, maximumFractionDigits: max, useGrouping: group }));
    return numFormats.get(k);
  };
  /** The number n written the way the page wrote it: same prefix, decimals, unit, suffix and digit grouping (en-US, like V.fmt / V.compact).
   *  `dec` (up to) more decimals while counting: "2M" passes "1.4M" (the page's own compact form, which drops a trailing ".0"). */
  const numText = (p, n, dec = p.dec) => p.pre + numFormat(p.dec, Math.max(p.dec, dec), p.group).format(n) + p.unit + p.suf;
  /** "8,008", "$0.000123", "12.3%", "250K", "#126", "73+", "7 days" → its parts; null for anything numText could not write back exactly. */
  function numParse(text) {
    const m = NUM.exec(text);
    if (!m) return null;
    const p = { pre: m[1], dec: m[3] ? m[3].length : 0, unit: m[4], suf: m[5] || "", group: m[2].includes(",") || m[2].length < 4, n: Number(m[2].replace(/,/g, "") + (m[3] ? "." + m[3] : "")) };
    return numText(p, p.n) === text ? p : null;
  }
  const numValue = (p) => p.n * UNIT[p.unit];

  function motionLayer(win, doc, still) {
    const IO = win.IntersectionObserver, MO = win.MutationObserver;
    let on = !still && Boolean(IO && MO);
    if (!on) return { arm() {}, finish() {}, watch() {}, on };
    const BLOCKS = "main .section-head, main .card, main .stat, main .reveal, main .city-stats > div, main .numbers__row > div, main .wanted > li, main .faq details, main .scam-note";
    const QUIET = ".dpv, .modal, .cstate, .timeline, [data-still]"; // its own motion, shown and hidden by its page, or the roadmap (every stop shows as it is)
    const NUMS = ".hero__facts strong, .numbers__row strong, .why-now__big, .stat > strong, .city-stats strong, .tile__num";
    const GLOW = [{ transform: "none", filter: "none" }, { transform: "translateY(-2px)", filter: "brightness(1.45) drop-shadow(0 0 10px rgba(255,138,91,.55))", offset: 0.3 }, { transform: "none", filter: "none" }];
    const timer = (f, ms) => win.setTimeout(f, ms);
    /** Inside a box that scrolls sideways (a carousel, a strip of tabs): a block there may sit beside the screen and never "scroll into
     *  view" vertically, so it would stay unseen. Never lowered. */
    const inScroller = (e) => {
      if (!win.getComputedStyle) return false;
      for (let p = e.parentElement; p && p.tagName !== "MAIN" && p.tagName !== "BODY"; p = p.parentElement) if (/auto|scroll/.test(win.getComputedStyle(p).overflowX)) return true;
      return false;
    };

    /* blocks */
    const rise = new IO((entries) => {
      let i = 0;
      for (const en of entries) if (en.isIntersecting) { rise.unobserve(en.target); show(en.target, Math.min(i++, 4) * 40); }
    }, { rootMargin: "0px 0px -8% 0px" });
    function show(e, delay) {
      if (delay) e.style.transitionDelay = `${delay}ms`;
      e.classList.add("mo-in");
      timer(() => { e.classList.remove("mo-armed", "mo-in"); e.style.transitionDelay = ""; }, delay + 500); // then the block is itself again (its own hover etc.)
    }
    /** Shows a block at once, with no transition: the keyboard is in it. */
    function now(e) { rise.unobserve(e); e.classList.remove("mo-armed", "mo-in"); e.style.transitionDelay = ""; }
    /** Lowers the blocks in these roots that are below the screen right now: never one on screen, a hidden one, one inside another
     *  block, or one that holds the keyboard focus (the Launchpad puts it back on the card it just redrew). */
    function arm(...roots) {
      if (!on) return;
      const found = new Set();
      for (const r of roots.length ? roots : [doc]) {
        if (r !== doc && r.matches && r.matches(BLOCKS)) found.add(r);
        if (r.querySelectorAll) for (const e of r.querySelectorAll(BLOCKS)) found.add(e);
      }
      const act = doc.activeElement, focused = (e) => Boolean(act && act !== doc.body && e.contains(act));
      const list = [...found].filter((e) => !e.classList.contains("mo-armed") && !e.closest(QUIET) && !(e.parentElement && e.parentElement.closest(BLOCKS)) && !focused(e) && !inScroller(e));
      const h = win.innerHeight || doc.documentElement.clientHeight;
      const rects = list.map((e) => e.getBoundingClientRect()); // every read first, then the writes: one layout
      list.forEach((e, i) => { if (rects[i].height > 0 && rects[i].top > h) { e.classList.add("mo-armed"); rise.observe(e); } });
    }
    // blocks a page script adds (a list of cities, the Launchpad's cards...): the same, once per frame; table rows never
    const added = new Set();
    let addQ = 0;
    const main = doc.querySelector("main");
    if (main) new MO((recs) => {
      for (const r of recs) for (const n of r.addedNodes) if (n.nodeType === 1 && !(r.target.closest && r.target.closest("table"))) added.add(n);
      if (added.size && !addQ) addQ = win.requestAnimationFrame(() => { addQ = 0; const list = [...added].filter((n) => n.isConnected); added.clear(); if (list.length) arm(...list); });
    }).observe(main, { childList: true, subtree: true });

    /* numbers */
    const nums = new Map(); // element → { p: its number (null while it shows words), seen: been on screen }
    const runs = new Map(); // element → a count in progress
    const live = new Map(); // aria-live region → counts running in it (it is aria-busy meanwhile, so a screen reader reads the end value once)
    let frame = 0;
    const numMo = new MO((recs) => {
      const hit = new Set();
      for (const r of recs) { let n = r.target; while (n && !nums.has(n)) n = n.parentNode; if (n) hit.add(n); }
      hit.forEach(wrote);
    });
    const seen = new IO((entries) => { for (const en of entries) if (en.isIntersecting) { seen.unobserve(en.target); first(en.target); } }, { threshold: 0.5 });
    /** A plain count (not a price, not a rank) above zero: the only kind that ever counts up from 0. */
    const fromZero = (p) => Boolean(p && p.n > 0 && p.pre === "");
    /** Has the browser drawn the page yet? (Paint Timing; a browser without it counts as not yet.) */
    const painted = () => { try { return win.performance.getEntriesByType("paint").length > 0; } catch { return false; } };
    /** On screen for the first time: it counts up from 0 to what it says, unless `drawn` (the visitor already sees the real number). */
    function first(e, drawn) {
      const s = nums.get(e); s.seen = true;
      if (on && !drawn && fromZero(s.p) && !doc.hidden) count(e, 0, s.p, e.textContent, false);
    }
    /** Starts following the live numbers. The ones on screen count now if the page is not drawn yet (their 0 is the first thing
     *  seen); once it is drawn, they stay exactly as they are and only a later change eases. */
    function watch(list) {
      list = list.filter((e) => !nums.has(e) && !e.childElementCount && !e.closest(".dpv, [data-countdown-short], [data-still]"));
      const h = win.innerHeight || doc.documentElement.clientHeight, rects = list.map((e) => e.getBoundingClientRect()), drawn = painted();
      list.forEach((e, i) => {
        nums.set(e, { p: numParse(e.textContent.trim()), seen: false });
        numMo.observe(e, { childList: true, characterData: true, subtree: true });
        const r = rects[i];
        if (r.height > 0 && r.top < h * 0.92 && r.bottom > 0 && !doc.hidden) first(e, drawn); else seen.observe(e);
      });
    }
    /** The page's script wrote new text into a number. */
    function wrote(e) {
      const s = nums.get(e), text = e.textContent, p = numParse(text.trim()), run = runs.get(e);
      const was = run ? run.cur * UNIT[run.p.unit] : s.p ? numValue(s.p) : null;
      s.p = p;
      if (!p || !s.seen || doc.hidden || !on) { if (run) stop(e, false); return; } // words, not seen yet, a hidden tab: the text as written
      if (was === null) { if (fromZero(p)) count(e, 0, p, text, false); return; } // its first number while on screen (a price or rank: as written)
      if (Math.abs(was - numValue(p)) <= Math.abs(numValue(p)) * 1e-9) { if (run) stop(e, false); return; } // the same value, maybe written another way ("1,000,000,000" → "1B")
      count(e, was, p, text, !run); // a new value: ease to it, with a glow if the old one had settled
    }
    function count(e, wasValue, p, text, glow) {
      const from = wasValue / UNIT[p.unit], to = p.n;
      const dec = p.dec || (p.unit && Math.max(from, to) < 100 ? 1 : 0); // "1B" passes through "0.4B", then ends on the page's "1B"
      if (!runs.has(e)) busy(e, 1);
      runs.set(e, { p, text, from, to, dec, cur: from, t0: null, ms: glow ? 900 : 1300 });
      put(e, numText(p, from, dec)); // at once, so the new text never flashes before its count
      if (glow && e.animate) e.animate(GLOW, { duration: 1100, easing: "cubic-bezier(.2,.8,.2,1)" });
      if (!frame) frame = win.requestAnimationFrame(tick);
    }
    function tick(now) {
      frame = 0;
      for (const [e, r] of runs) {
        if (r.t0 === null) r.t0 = now; // its first frame
        const k = Math.min(1, (now - r.t0) / r.ms);
        if (k >= 1) { stop(e, true); continue; }
        r.cur = r.from + (r.to - r.from) * (1 - (1 - k) ** 3);
        put(e, numText(r.p, r.cur, r.dec));
      }
      if (runs.size) frame = win.requestAnimationFrame(tick);
    }
    /** Our own writes are never read back as the page's (their records are dropped right away). */
    function put(e, text) { if (e.textContent !== text) e.textContent = text; numMo.takeRecords(); }
    /** Ends a count; `write` puts the page's own text back (false: it is already there). */
    function stop(e, write) { const r = runs.get(e); if (!r) return; runs.delete(e); if (write) put(e, r.text); busy(e, -1); }
    function busy(e, d) {
      const region = e.closest('[aria-live]:not([aria-live="off"])');
      if (!region) return;
      const n = (live.get(region) || 0) + d;
      if (n > 0) { live.set(region, n); region.setAttribute("aria-busy", "true"); } else { live.delete(region); region.removeAttribute("aria-busy"); }
    }
    /** Everything to its end state at once: every count ends on the page's text, every armed block shows. */
    function finish() {
      for (const e of [...runs.keys()]) stop(e, true);
      for (const e of doc.querySelectorAll(".mo-armed")) now(e);
    }
    // the keyboard reaches a control inside a block still waiting (or still fading in): it shows now, never a focused control at opacity 0
    doc.addEventListener("focusin", (ev) => { const b = ev.target && ev.target.closest ? ev.target.closest(".mo-armed") : null; if (b) now(b); });

    /* a hidden tab finishes every count at once; asking for less motion meanwhile stops everything now */
    doc.addEventListener("visibilitychange", () => { if (doc.hidden) for (const e of [...runs.keys()]) stop(e, true); });
    const q = win.matchMedia ? win.matchMedia("(prefers-reduced-motion: reduce)") : null;
    if (q && q.addEventListener) q.addEventListener("change", () => { if (q.matches) { on = false; finish(); } });

    arm();
    watch([...doc.querySelectorAll(NUMS)]);
    return { arm, finish, watch, on };
  }
  /* motion: end */

  /* ---------- segmented controls: one marker under the chosen segment, sliding to a new choice ---------- */
  // Each .seg (the Launchpad's lists, the dashboard's switches) gets one marker (.seg__ind, hidden from screen readers) that sits
  // under the chosen button and glides to the next one (transform only, 240 ms; at once with reduced motion). Until it has measured
  // the chosen button (a control in a hidden panel has no size yet) the button keeps its own look, and so it does without this script.
  function segments(win, doc) {
    const RO = win.ResizeObserver, MO = win.MutationObserver;
    if (!RO || !MO) return;
    const CHOSEN = 'button[aria-selected="true"], button[aria-pressed="true"]';
    for (const seg of doc.querySelectorAll(".seg")) {
      const ind = el("span", "seg__ind");
      ind.setAttribute("aria-hidden", "true");
      seg.append(ind);
      let at = null; // where the marker is: { x, y, w }
      const place = (glide) => {
        const b = seg.querySelector(CHOSEN);
        if (!b || !b.offsetWidth) return; // nothing chosen, or not laid out yet: the button's own look stays
        const to = { x: b.offsetLeft, y: b.offsetTop, w: b.offsetWidth, h: b.offsetHeight };
        if (at && at.x === to.x && at.y === to.y && at.w === to.w && at.h === to.h) return;
        ind.style.width = `${to.w}px`; ind.style.height = `${to.h}px`; ind.style.transform = `translate(${to.x}px, ${to.y}px)`;
        if (glide && at && !reducedNow() && ind.animate) {
          ind.animate([{ transform: `translate(${at.x}px, ${at.y}px) scaleX(${at.w / to.w})` }, { transform: `translate(${to.x}px, ${to.y}px)` }],
            { duration: 240, easing: "cubic-bezier(.2,.8,.2,1)" });
        }
        at = to;
        seg.classList.add("has-ind");
      };
      new MO(() => place(true)).observe(seg, { subtree: true, attributes: true, attributeFilter: ["aria-selected", "aria-pressed"] });
      const ro = new RO(() => place(false));
      ro.observe(seg);
      for (const b of seg.querySelectorAll("button")) ro.observe(b);
    }
  }
  segments(window, document);
  const motion = motionLayer(window, document, reduced);
  /** Lets a page's blocks rise in once its script has shown them (dashboard.js after the dashboard opens). */
  const reveal = (root) => motion.arm(...(root ? [root] : []));
  /** Live numbers a page script made after the start (the Launchpad's cards, the coin page): from now on, a new value the script
   *  writes eases from the old one (a price never counts from 0). Text-only elements; nothing happens with reduced motion. */
  const liveNums = (els) => motion.watch([...els]);

  /* ---------- who's signed in (the header: Log in, or one avatar) ---------- */
  let meLite = null;
  const ready = api("/api/me?lite=1").then((d) => {
    meLite = d;
    const b = $("[data-account]"), label = $("[data-account-label]"), av = $("[data-account-avatar]");
    if (d.signedIn && d.user) {
      // signed in: one avatar, top right, and no username pill beside it (owner, 17 Oct 2026). The avatar opens the account sheet, with
      // the username and home community at its top, then Profile, Account and Settings (accountSheet below)
      if (b) b.hidden = true;
      try { localStorage.setItem("vicinity-account", "1"); } catch {} // remembered so /connect opens on "Log in"
      if (av) accountSheet(av, d.user);
    } else {
      if (d.pending && b) label.textContent = "Finish sign-in";
      if (b) b.classList.add("is-shown"); // a returning member's browser holds it back until the answer (polish.css), so it never flashes
      if (av) av.classList.add("is-off");
    }
    // the header's "Sign up": only for someone signed out. A returning member's browser hides it before the first paint (style.css,
    // :root:not([data-guest])), so it never flashes; it shows once the answer says signed out.
    const signup = $("[data-signup]");
    if (signup) {
      signup.hidden = Boolean(d && (d.signedIn || d.pending));
      if (!signup.hidden) signup.classList.add("is-shown");
    }
    if (d && d.profilesFlag) $$("[data-profiles-only]").forEach((e) => (e.hidden = false)); // copy about member profiles shows only while they are switched on
    if (d && d.feedV2) $$("[data-feed-v2-only]").forEach((e) => (e.hidden = false)); // and the feed v2 sentences (delete your own post, mute) only while FEED_V2 is on
    document.dispatchEvent(new CustomEvent("vicinity:me", { detail: d }));
    return d;
  });

  /* ---------- the account sheet: the header's one avatar (signed in) ----------
     One button, top right, on every page: the member's initial (the site has no member pictures). It opens one sheet (a bottom sheet on
     a phone, a small popover under the avatar on a computer: polish.css, the same query as SHEET_MQ) with the username and the home
     community at the top, then Profile, Account and Settings, each an existing place of the dashboard, and Log out (the profile's own
     Log out: the same request, then the home page). On the dashboard the three open in place (its tabs: it hands over V.accountGo), anywhere
     else they are links to it. A dialog: the button says aria-haspopup / aria-expanded, the keyboard moves into the sheet and stays there
     (Tab wraps), Escape, the close button, a tap outside or a swipe down on a phone close it, and the keyboard goes back to the avatar.
     It slides (a phone) or fades (a computer) with the Web Animations API, at once with reduced motion; nothing loops. */
  const SHEET_MQ = "(max-width: 600px)";
  let setAccount = () => {};
  function accountSheet(btn, user) {
    const sheet = $("[data-acct]"), panel = sheet && $(".acct__panel", sheet);
    if (!sheet || !panel) return;
    const scrim = $(".acct__scrim", sheet);
    const regions = (() => { try { return new Intl.DisplayNames(["en"], { type: "region" }); } catch { return null; } })();
    const country = (cc) => { try { return (regions && regions.of(cc)) || cc; } catch { return cc; } };
    setAccount = (u) => {
      if (!u) return;
      const who = u.handle || u.name || short(u.wallet) || "Your account";
      const face = initials(u.handle || u.name || "V");
      $("[data-account-initial]", btn).textContent = face;
      $("[data-acct-initial]", sheet).textContent = face;
      $("[data-acct-name]", sheet).textContent = who;
      $("[data-acct-home]", sheet).textContent = u.home ? `${u.home.name}, ${country(u.home.country)}` : "No home community yet";
      btn.setAttribute("aria-label", `Profile, account and settings (${who})`);
    };
    setAccount(user);
    btn.hidden = false;
    let state = "closed", anims = [], drag = null, dragEnd = 0;
    const phone = () => Boolean(window.matchMedia && window.matchMedia(SHEET_MQ).matches);
    const stops = () => $$("a[href], button:not([disabled])", panel).filter((e) => e.getClientRects().length);
    const stopAnims = () => { for (const a of anims) a.cancel(); anims = []; };
    /** The sheet's own motion (in: a phone's sheet rises, the popover fades down a little; out: the reverse, then it hides). */
    function move(opening, done) {
      stopAnims();
      panel.style.transform = "";
      if (reducedNow() || typeof panel.animate !== "function") { if (done) done(); return; }
      const ph = phone(), from = drag && drag.y > 0 ? `translateY(${drag.y}px)` : null;
      const shut = ph ? { transform: "translateY(100%)" } : { opacity: 0, transform: "translateY(-6px) scale(.97)" };
      const open = { opacity: 1, transform: "none" };
      const ms = opening ? (ph ? 320 : 180) : (ph ? 220 : 140), easing = opening ? "cubic-bezier(.2,.8,.2,1)" : "cubic-bezier(.4,0,1,1)";
      const p = panel.animate(opening ? [shut, open] : [from ? { transform: from } : open, shut], { duration: ms, easing, fill: "both" });
      const s = scrim.animate(opening ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 0 }], { duration: ms, easing: "linear", fill: "both" });
      anims = [p, s];
      p.onfinish = () => { if (anims[0] !== p) return; if (done) done(); if (opening) stopAnims(); };
    }
    function open() {
      if (state === "open") return;
      state = "open";
      sheet.hidden = false;
      btn.setAttribute("aria-expanded", "true");
      // a finger dragging the sheet down moves it (a phone): anywhere on it while it has nothing to scroll, else from its top (polish.css)
      panel.style.touchAction = phone() && panel.scrollHeight <= panel.clientHeight + 1 ? "none" : "";
      move(true);
      const first = $(".acct__link", panel);
      if (first) first.focus({ preventScroll: true });
    }
    /** restore: the keyboard goes back to the avatar (not when a link takes the person somewhere). */
    function close(restore = true) {
      if (state !== "open") return;
      state = "closing";
      btn.setAttribute("aria-expanded", "false");
      move(false, () => { if (state !== "closing") return; state = "closed"; sheet.hidden = true; stopAnims(); });
      drag = null;
      if (restore) btn.focus({ preventScroll: true });
    }
    btn.addEventListener("click", () => (state === "open" ? close() : open()));
    document.addEventListener("keydown", (e) => {
      if (state !== "open") return;
      if (e.key === "Escape") { e.preventDefault(); close(); return; }
      if (e.key !== "Tab") return;
      const f = stops();
      if (!f.length) return;
      const at = document.activeElement, i = f.indexOf(at);
      if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && (i === -1 || i === f.length - 1)) { e.preventDefault(); f[0].focus(); }
    });
    sheet.addEventListener("click", (e) => {
      if (Date.now() - dragEnd < 400) { e.preventDefault(); return; } // the end of a drag is not a tap on a link
      if (e.target.closest("[data-acct-close]")) { close(); return; }
      const a = e.target.closest("[data-acct-go]");
      // the dashboard opens the place in place, no reload (it hands its opener over: V.accountGo, or its profile dialog V.openProfile);
      // on any other page the link goes to the dashboard
      const go = typeof window.V.accountGo === "function" ? window.V.accountGo : typeof window.V.openProfile === "function" ? () => window.V.openProfile() : null;
      if (!a || !go) return;
      e.preventDefault(); close(false);
      go((a.getAttribute("href") || "").split("#")[1] || "profile");
    });
    $("[data-acct-logout]", sheet).addEventListener("click", async (e) => {
      e.currentTarget.disabled = true;
      await api("/api/auth/logout", {});
      location.assign("/");
    });
    // a phone: the sheet follows a finger dragging it down from its top, and goes once it is pulled far enough (or flicked)
    panel.addEventListener("pointerdown", (e) => {
      if (state !== "open" || e.pointerType === "mouse" || !phone() || panel.scrollTop > 0) return;
      drag = { id: e.pointerId, y0: e.clientY, t0: Date.now(), y: 0, on: false };
    });
    panel.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dy = e.clientY - drag.y0;
      if (!drag.on && dy > 8) { drag.on = true; stopAnims(); }
      if (!drag.on) return;
      drag.y = Math.max(0, dy);
      panel.style.transform = `translateY(${drag.y}px)`;
    });
    const release = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const d = drag, fast = d.y / Math.max(1, Date.now() - d.t0) > 0.6;
      if (!d.on) { drag = null; return; }
      dragEnd = Date.now();
      if (d.y > Math.min(120, panel.offsetHeight / 3) || (fast && d.y > 24)) close();
      else { drag = null; panel.style.transform = ""; if (!reducedNow() && typeof panel.animate === "function") anims = [panel.animate([{ transform: `translateY(${d.y}px)` }, { transform: "none" }], { duration: 200, easing: "cubic-bezier(.2,.8,.2,1)" })]; }
    };
    panel.addEventListener("pointerup", release);
    panel.addEventListener("pointercancel", release);
  }

  /* ---------- live launch countdown (short form, used in several places) ---------- */
  let opensAt = Date.parse("2026-10-10T10:10:10-04:00");
  let siteMode = "live";
  const official = api("/api/official").then((o) => {
    if (o && o.launchpadOpensAt) opensAt = Date.parse(o.launchpadOpensAt);
    if (o && o.siteMode) { siteMode = o.siteMode; if (siteMode === "preview") showPreviewBanner(); }
    tickShort();
    return o;
  });
  function showPreviewBanner() {
    if (document.getElementById("preview-banner")) return;
    const b = document.createElement("div");
    b.id = "preview-banner";
    b.setAttribute("role", "note");
    b.style.cssText = "position:sticky;top:0;z-index:9999;background:#7c3aed;color:#fff;text-align:center;font:600 13px/1.4 system-ui,sans-serif;padding:8px 12px;letter-spacing:.02em";
    b.textContent = "TEST ENVIRONMENT — previewing the post-launch site. Nothing here is real yet.";
    document.body.prepend(b);
  }
  const launchOpen = () => opensAt <= Date.now();
  function shortCountdown() {
    const ms = opensAt - Date.now();
    const d = Math.floor(ms / 86400000), h = Math.floor((ms % 86400000) / 3600000);
    return d > 0 ? `${d}d ${h}h` : `${h}h ${Math.floor((ms % 3600000) / 60000)}m`;
  }
  // Every 30 s (and when /api/official answers): the short countdown ("13h 23m" over its label). Once the Launchpad is
  // open, the same fact reads "Live / Launchpad is open" (its tile turns green: .is-live), the menu's "Oct 10" chip reads "Open", and
  // "vicinity:launchpad-open" fires once on document (home.js marks the roadmap). A page left open across 10:10:10 flips by itself.
  let flipped = false;
  function tickShort() {
    const open = launchOpen();
    $$("[data-countdown-short]").forEach((e) => {
      if (!open) { e.textContent = shortCountdown(); return; }
      const fact = e.closest("li"), label = fact && fact.querySelector("[data-countdown-label]");
      if (e.textContent !== "Live") e.textContent = "Live";
      if (label && label.textContent !== "Launchpad is open") label.textContent = "Launchpad is open";
      if (fact) fact.classList.add("is-live");
    });
    if (!open || flipped) return;
    flipped = true;
    $$("[data-nav-launch]").forEach((e) => { e.textContent = "Open"; e.classList.remove("nav__soon"); e.classList.add("nav__open"); });
    document.dispatchEvent(new CustomEvent("vicinity:launchpad-open"));
  }
  tickShort(); setInterval(tickShort, 30000);

  /* ---------- the floating header: a stronger glass once the page has scrolled (no scroll listener: a 1 px marker at the top) ---------- */
  (() => {
    const head = $("[data-header]");
    if (!head || !window.IntersectionObserver) return;
    const mark = el("div", "hdr-sentinel");
    mark.setAttribute("aria-hidden", "true");
    document.body.prepend(mark);
    new IntersectionObserver(([en]) => head.classList.toggle("is-scrolled", !en.isIntersecting)).observe(mark);
  })();

  /* ---------- Terms of Use ----------
     No site-entry gate any more (design v4, 12 Oct 2026: the owner asked for the Terms pop-up to go). The Terms are accepted where they
     bind: at account creation (the sign-up's "I agree" box and "Agree and continue", recorded server-side as users.terms_version,
     src/signup.js) and on /terms itself (its inline "I agree"); every page's footer links them. V.termsGate stays with the same two
     methods, so signup.js and connect.js need no change: open() has nothing to open, agreed(version) notes the account's version here. */
  const termsGate = {
    open() {},
    agreed(version) { try { if (version) localStorage.setItem("vicinity_terms", version); } catch { /* private mode: nothing to note */ } },
  };
  if (document.body.dataset.page === "terms") {
    const inline = $("#terms-agree");
    if (inline) inline.addEventListener("click", () => {
      try { localStorage.setItem("vicinity_terms", "2026-10-01"); } catch { /* private mode */ }
      ready.then((d) => { if (d && d.signedIn) api("/api/me/terms", { version: "2026-10-01" }); });
      inline.disabled = true;
      inline.textContent = "Agreed ✓";
      toast("Thanks — you're all set.");
    });
  }

  /* ---------- a member whose account has no agreement to the current Terms on record ----------
     An account from before the sign-up recorded the Terms (or one the owner's console made) was asked by the site-entry pop-up; that
     pop-up is gone (design v4), so such a member sees one quiet bar at the foot of the screen instead: never blocking, "Later" hides it
     for this visit, "I agree" records it for the account (POST /api/me/terms, the same call as /terms' own button). Visitors never see
     it (no account, nothing to record), and a member who agreed at sign-up never does either. Only with the new sign-up on: its
     /api/me answer says which version the account agreed to. Not on /terms (its own button) or /connect (the sign-up itself). */
  const TERMS_NOW = "2026-10-01";
  ready.then((d) => {
    if (!d || !d.signedIn || d.signupFlow !== "v2" || !("termsVersion" in d) || d.termsVersion === TERMS_NOW) return;
    if (["terms", "connect"].includes(document.body.dataset.page)) return;
    try { if (sessionStorage.getItem("vicinity-terms-later") === TERMS_NOW) return; } catch { /* storage off: the bar shows */ }
    const bar = el("section", "terms-note");
    bar.setAttribute("aria-label", "Terms of Use");
    const text = el("p", "terms-note__text", "Please confirm the ");
    const link = el("a", null, "Terms of Use"); link.href = "/terms";
    text.append(link, " for your account.");
    const later = el("button", "btn btn--ghost btn--sm terms-note__later", "Later"); later.type = "button";
    const yes = el("button", "btn btn--primary btn--sm terms-note__yes", "I agree"); yes.type = "button";
    const acts = el("div", "terms-note__acts"); acts.append(later, yes);
    bar.append(text, acts);
    later.addEventListener("click", () => { try { sessionStorage.setItem("vicinity-terms-later", TERMS_NOW); } catch { /* storage off */ } bar.remove(); });
    yes.addEventListener("click", async () => {
      yes.disabled = true;
      const r = await api("/api/me/terms", { version: TERMS_NOW });
      if (r && r.ok) { termsGate.agreed(TERMS_NOW); bar.remove(); toast("Thanks, that's recorded."); return; }
      yes.disabled = false; toast("That didn't go through. Please try again.");
    });
    document.body.append(bar);
  });

  window.V = { $, $$, el, fmt, compact, mask, short, ago, isAddr, initials, toast, burst, copy, api, getLocation, webView, takeCarry, takeLink, walletApp, termsGate, liveNums, reveal,
    get reduced() { return reducedNow(); }, // read when it is needed: the device setting can change while the page is open
    me: () => meLite, ready, official, opensAt: () => opensAt, launchOpen, siteMode: () => siteMode,
    setAccount: (u) => setAccount(u) }; // the dashboard keeps the account sheet's name and home in step with /api/me
})();
