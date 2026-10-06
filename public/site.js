// Vicinity: shared by every page. Header account button, toasts, scroll reveals, small helpers.
// No trackers, no outside requests: everything talks to this site's own /api.
(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  // less motion: the device asks for it, or the visitor pressed "Pause animations" in the footer (theme.js, before the first paint)
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

  const toast = (msg) => {
    const t = $("#toast"); if (!t) return;
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 3000);
  };
  const burst = (x, y) => {
    if (reduced) return;
    for (let i = 0; i < 10; i++) {
      const s = el("span", "burst", ["📍", "✨", "🔥", "🏅"][i % 4]);
      s.style.left = `${x}px`; s.style.top = `${y}px`;
      const a = Math.random() * Math.PI * 2, d = 50 + Math.random() * 70;
      s.style.setProperty("--bx", `${Math.cos(a) * d}px`); s.style.setProperty("--by", `${Math.sin(a) * d}px`);
      document.body.append(s); setTimeout(() => s.remove(), 950);
    }
  };
  /** Copies text and says so in the toast; answers true when it reached the clipboard (false: the toast shows the text to copy by hand). */
  const copy = async (text, label = "Copied") => { try { await navigator.clipboard.writeText(text); toast(label); return true; } catch { toast(text); return false; } };

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
   * The person's position, once. Rejects with an Error whose .code is "unsupported" | "denied" | "timeout" | "unavailable"
   * and whose .inApp says whether this is a wallet app's browser (pages then offer to finish in the phone's browser).
   * GPS first; if it doesn't answer, a network-based position (the server accepts anything within 20 km).
   */
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
      const ok = (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: Math.round(p.coords.accuracy || 0) });
      const why = (e) => (e && e.code === 1 ? "denied" : e && e.code === 3 ? "timeout" : "unavailable");
      navigator.geolocation.getCurrentPosition(ok, (e) => {
        if (e && e.code === 1) return reject(fail("denied"));
        navigator.geolocation.getCurrentPosition(ok, (e2) => reject(fail(why(e2))), { enableHighAccuracy: false, timeout: 15000, maximumAge: 30000 });
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
  // * the moving parts of a page's top section (orbs, stars, chips, the headline's colours), of the home page's NYC map and timeline, and
  //   every live dot's ping pause while they are off screen (.mo-off): an animation nobody can see never costs a frame.
  // * live buttons (style.css "Live buttons"): each one pauses while it is off screen (.mo-off on the button itself, buttons a page
  //   script adds later too) and every one of them while the tab is hidden (.mo-hidden on <html>). Their light passes are spread out
  //   (--sweep-delay), so two buttons side by side never shine at the same moment.
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
    const QUIET = ".dpv, .termsgate, .modal, .cstate, [data-still]"; // its own motion, or shown and hidden by its page
    const NUMS = ".hero__facts strong, .numbers__row strong, .why-now__big, .stat > strong, .city-stats strong, .tile__num";
    const HEROES = ".hero, .launch-hero, .page-hero, .connect, .dash-out, main > .section:first-child";
    const LOOPS = ".nyc, .timeline, .live-dot"; // further down a page, but moving for as long as it is open
    // every control with a loop of its own (style.css "Live buttons"); the ones that shine get a --sweep-delay of their own
    // (.lp-card, .coin-live: the Launchpad's live coin cards and the coin page's live parts, whose dots ping and lines glow)
    const LIVE = ".btn, .contract__buy, .contract__ext, .chip-link, .map-open, .map-ctrl button, .chips button, .su-tab, a[role=tab], .nav a, .tabbar a, .seg__ind, .lp-card, .coin-live";
    const SHINES = ".btn--primary, .btn--glass, .btn--social, .account-btn, .contract__buy, .contract__ext, .chip-link, .map-open";
    const GLOW = [{ transform: "none", filter: "none" }, { transform: "translateY(-2px)", filter: "brightness(1.45) drop-shadow(0 0 10px rgba(255,138,91,.55))", offset: 0.3 }, { transform: "none", filter: "none" }];
    const timer = (f, ms) => win.setTimeout(f, ms);

    /* blocks */
    const rise = new IO((entries) => {
      let i = 0;
      for (const en of entries) if (en.isIntersecting) { rise.unobserve(en.target); show(en.target, Math.min(i++, 4) * 60); }
    }, { rootMargin: "0px 0px -8% 0px" });
    function show(e, delay) {
      if (delay) e.style.transitionDelay = `${delay}ms`;
      e.classList.add("mo-in");
      timer(() => { e.classList.remove("mo-armed", "mo-in"); e.style.transitionDelay = ""; }, delay + 700); // then the block is itself again (its own hover etc.)
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
      const list = [...found].filter((e) => !e.classList.contains("mo-armed") && !e.closest(QUIET) && !(e.parentElement && e.parentElement.closest(BLOCKS)) && !focused(e));
      const h = win.innerHeight || doc.documentElement.clientHeight;
      const rects = list.map((e) => e.getBoundingClientRect()); // every read first, then the writes: one layout
      list.forEach((e, i) => { if (rects[i].height > 0 && rects[i].top > h) { e.classList.add("mo-armed"); rise.observe(e); } });
    }
    // blocks a page script adds (a list of cities, the Launchpad's cards...): the same, once per frame; table rows never
    const added = new Set();
    let addQ = 0;
    const main = doc.querySelector("main");
    if (main) new MO((recs) => {
      for (const r of recs) {
        for (const n of r.addedNodes) if (n.nodeType === 1 && !(r.target.closest && r.target.closest("table"))) added.add(n);
        for (const n of r.removedNodes || []) if (n.nodeType === 1) for (const e of liveIn(n)) away.unobserve(e); // a redrawn list lets its old buttons go
      }
      if (added.size && !addQ) addQ = win.requestAnimationFrame(() => { addQ = 0; const list = [...added].filter((n) => n.isConnected); added.clear(); if (list.length) { arm(...list); list.forEach(watchLive); } });
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

    /* the top section's drifting parts, the loops further down and every live button pause while they are off screen */
    const away = new IO((entries) => { for (const en of entries) en.target.classList.toggle("mo-off", !en.isIntersecting); });
    for (const e of doc.querySelectorAll(`${HEROES}, ${LOOPS}`)) away.observe(e);
    let shine = 0;
    /** The live buttons in (or at) n: watched on and off screen; each one that shines takes the next spot in the 7 s cycle. */
    function liveIn(n) { return n.querySelectorAll ? [...(n.matches && n.matches(LIVE) ? [n] : []), ...n.querySelectorAll(LIVE)] : []; }
    function watchLive(n) {
      for (const e of liveIn(n)) {
        away.observe(e);
        if (e.matches(SHINES) && e.style.setProperty && !e.style.getPropertyValue("--sweep-delay")) {
          e.style.setProperty("--sweep-delay", `${(0.8 + ((shine++ * 0.618) % 1) * 7).toFixed(2)}s`); // golden-ratio steps: a button and the next two never shine together
        }
      }
    }
    watchLive(doc);

    const rootEl = doc.documentElement, hiddenMark = () => { if (rootEl.classList) rootEl.classList.toggle("mo-hidden", Boolean(doc.hidden)); };
    hiddenMark();
    doc.addEventListener("visibilitychange", () => { hiddenMark(); if (doc.hidden) for (const e of [...runs.keys()]) stop(e, true); });
    const q = win.matchMedia ? win.matchMedia("(prefers-reduced-motion: reduce)") : null;
    if (q && q.addEventListener) q.addEventListener("change", () => { if (q.matches) { on = false; finish(); } }); // asked for less motion meanwhile: stop now
    // "Pause animations" pressed meanwhile (theme.js): the same. Played again: the page moves again from the next page on.
    if (win.addEventListener) win.addEventListener("vicinity:motion", (ev) => { if (ev.detail === "paused") { on = false; finish(); } });

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

  /* ---------- who's signed in (header button) ---------- */
  let meLite = null;
  const ready = api("/api/me?lite=1").then((d) => {
    meLite = d;
    const b = $("[data-account]"), label = $("[data-account-label]");
    if (d.signedIn && b) {
      b.href = "/dashboard#profile"; b.classList.add("is-in");
      const who = d.user.handle || d.user.name || short(d.user.wallet);
      label.textContent = who.length > 16 ? who.slice(0, 15) + "…" : who;
      // the header username button IS the profile button: on the dashboard it
      // opens the profile modal in place, anywhere else it lands on it
      b.setAttribute("aria-label", `Profile and settings (${who})`);
      try { localStorage.setItem("vicinity-account", "1"); } catch {} // remembered so /connect opens on "Log in"
      b.addEventListener("click", (e) => {
        if (document.body.dataset.page === "dashboard" && typeof window.V.openProfile === "function") {
          e.preventDefault();
          window.V.openProfile();
        }
      });
    } else if (d.pending && b) {
      label.textContent = "Finish sign-in";
    }
    if (d && d.profilesFlag) $$("[data-profiles-only]").forEach((e) => (e.hidden = false)); // copy about member profiles shows only while they are switched on
    document.dispatchEvent(new CustomEvent("vicinity:me", { detail: d }));
    return d;
  });

  /* ---------- live launch countdown (short form, used in several places) ---------- */
  let opensAt = Date.parse("2026-10-10T10:10:10-04:00");
  let siteMode = "live";
  const official = api("/api/official").then((o) => {
    if (o && o.launchpadOpensAt) opensAt = Date.parse(o.launchpadOpensAt);
    if (o && o.siteMode) { siteMode = o.siteMode; if (siteMode === "preview") showPreviewBanner(); }
    // nav "Oct 10" chip flips to "Open" once the launchpad date has passed
    if (opensAt <= Date.now()) $$("[data-nav-launch]").forEach((e) => {
      e.textContent = "Open"; e.classList.remove("nav__soon"); e.classList.add("nav__open");
    });
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
  function shortCountdown() {
    const ms = opensAt - Date.now();
    if (ms <= 0) return "Open now";
    const d = Math.floor(ms / 86400000), h = Math.floor((ms % 86400000) / 3600000);
    return d > 0 ? `${d}d ${h}h` : `${h}h ${Math.floor((ms % 3600000) / 60000)}m`;
  }
  const tickShort = () => $$("[data-countdown-short]").forEach((e) => (e.textContent = shortCountdown()));
  if ($("[data-countdown-short]")) { official.then(tickShort); tickShort(); setInterval(tickShort, 30000); }

  /* ---------- backend status in the footer ---------- */
  (async () => {
    const s = $("#status"); if (!s) return;
    const d = await api("/api/health");
    s.textContent = d.ok ? "online ✓" : "offline";
  })();

  /* ---------- terms gate: agree before entry ---------- */
  (() => {
    const key = "vicinity_terms";
    const record = (version) => {
      try { localStorage.setItem(key, version); } catch { /* private mode: gate reappears next visit */ }
      ready.then((d) => { if (d && d.signedIn) api("/api/me/terms", { version }); });
    };
    // The terms page itself stays readable without the gate; it gets an inline agree button instead.
    if (document.body.dataset.page === "terms") {
      const inline = $("#terms-agree");
      if (inline) inline.addEventListener("click", () => {
        record("2026-10-01");
        inline.disabled = true;
        inline.textContent = "Agreed ✓";
        toast("Thanks — you're all set.");
      });
      return;
    }
    const gate = $("#termsgate");
    if (!gate) return;
    const version = gate.dataset.termsVersion || "2026-10-01";
    let agreed = null;
    try { agreed = localStorage.getItem(key); } catch { /* ignore */ }
    if (agreed === version) return;

    // Keyboard and screen readers. While the gate is open the page behind it is inert (no Tab stops, hidden from
    // screen readers), the keyboard starts on the dialog's heading, Tab and Shift+Tab go round the dialog's own
    // controls, and Escape does nothing (agreeing is the only way in). The overlay already covers the whole page,
    // so nothing changes for a mouse or a finger. The toast stays outside the inert part so it can still be read out.
    const card = $(".termsgate__card", gate);
    const heading = () => $("#termsgate-title", card);
    const before = document.activeElement;
    const behind = [...document.body.children].filter((e) => e !== gate && e.id !== "toast" && !e.inert);
    const stops = () => $$("a[href], button, input, select, textarea, summary, [tabindex]", card)
      .filter((e) => e.tabIndex >= 0 && !e.disabled && e.getClientRects().length);
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); return; }
      if (e.key !== "Tab" || e.ctrlKey || e.altKey || e.metaKey) return; // Ctrl+Tab and friends belong to the browser
      const list = stops(), at = list.indexOf(document.activeElement);
      if (!list.length) { e.preventDefault(); return; }
      // Only the ends need help: from the last stop (or from outside) Tab goes to the first, and from the first stop
      // (or the heading, or outside) Shift+Tab goes to the last. Everything in between is the browser's own Tab.
      const wrap = e.shiftKey ? at <= 0 : at === list.length - 1 || !card.contains(document.activeElement);
      if (wrap) { e.preventDefault(); list[e.shiftKey ? list.length - 1 : 0].focus(); }
    };
    const focusHeading = () => { const h = heading(); h.tabIndex = -1; h.focus({ preventScroll: true }); };

    gate.hidden = false;
    behind.forEach((e) => (e.inert = true));
    document.addEventListener("keydown", onKey, true);
    focusHeading();

    $("#termsgate-agree").addEventListener("click", () => {
      record(version);
      gate.hidden = true;
      behind.forEach((e) => (e.inert = false));
      document.removeEventListener("keydown", onKey, true);
      // The keyboard goes back where it was before the gate opened or, on a first visit (nothing was focused yet),
      // to the start of the page's content: the same place the "Skip to content" link goes.
      if (before && before !== document.body && before.isConnected && before.getClientRects().length) { before.focus({ preventScroll: true }); return; }
      const main = $("#main");
      if (!main) return;
      if (!main.hasAttribute("tabindex")) {
        main.tabIndex = -1;
        main.addEventListener("blur", () => main.removeAttribute("tabindex"), { once: true });
      }
      main.focus({ preventScroll: true });
    });
    $("#termsgate-decline").addEventListener("click", () => {
      // The new heading keeps the dialog's name (aria-labelledby) and takes the keyboard, since the pressed button is gone.
      card.innerHTML =
        '<div class="termsgate__done"><p class="kicker">No problem</p>' +
        '<h2 id="termsgate-title">You&rsquo;ll need to agree to enter</h2>' +
        '<p class="muted">The Terms of Use keep everyone on the same page. You can read them any time and come back when you&rsquo;re ready.</p>' +
        '<p><a href="/terms">Read the Terms of Use</a></p></div>';
      focusHeading();
    });
  })();

  window.V = { $, $$, el, fmt, compact, mask, short, ago, isAddr, initials, toast, burst, copy, api, getLocation, webView, liveNums, reveal,
    get reduced() { return reducedNow(); }, // read when it is needed: the visitor may pause the animations while the page is open
    me: () => meLite, ready, official, opensAt: () => opensAt, siteMode: () => siteMode };
})();
