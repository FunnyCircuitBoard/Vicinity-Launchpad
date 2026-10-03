// Vicinity: shared by every page. Header account button, toasts, scroll reveals, small helpers.
// No trackers, no outside requests: everything talks to this site's own /api.
(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
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
  const copy = async (text, label = "Copied") => { try { await navigator.clipboard.writeText(text); toast(label); } catch { toast(text); } };

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

  /* ---------- reveal on scroll ---------- */
  const io = "IntersectionObserver" in window ? new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add("is-in"); io.unobserve(e.target); }
  }, { threshold: 0.1, rootMargin: "0px 0px -30px 0px" }) : null;
  const reveal = (root = document) => $$(".reveal:not(.is-in)", root).forEach((e, i) => { e.style.transitionDelay = `${(i % 4) * 60}ms`; if (io && !reduced) io.observe(e); else e.classList.add("is-in"); });
  reveal();

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
    gate.hidden = false;
    $("#termsgate-agree").addEventListener("click", () => { record(version); gate.hidden = true; });
    $("#termsgate-decline").addEventListener("click", () => {
      gate.querySelector(".termsgate__card").innerHTML =
        '<div class="termsgate__done"><p class="kicker">No problem</p>' +
        "<h2>You&rsquo;ll need to agree to enter</h2>" +
        '<p class="muted">The Terms of Use keep everyone on the same page. You can read them any time and come back when you&rsquo;re ready.</p>' +
        '<p><a href="/terms">Read the Terms of Use</a></p></div>';
    });
  })();

  window.V = { $, $$, el, fmt, compact, mask, short, ago, isAddr, initials, toast, burst, copy, api, getLocation, webView, reveal, reduced,
    me: () => meLite, ready, official, opensAt: () => opensAt, siteMode: () => siteMode };
})();
