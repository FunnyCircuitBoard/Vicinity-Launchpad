// Dashboard: first-visit onboarding (rank + home community), then the live dashboard:
// identity + role, ranks, the founder path (qualify → apply → endorse → chosen → objections → founder, with grace),
// badges (re-checked every minute), community and country (elections), local / national feeds,
// moderator tools (reasons, second confirmations, ban approvals, appeals), town requests.
// Onboarding v3: an account can exist without a wallet. Such a member sees the welcome moment once (/dashboard?welcome=1), a
// 2-of-3 setup ring, and the link card (#wallet-card) that leads to /connect?mode=link; the pass, the tiles, the badges and the
// role card say "link a wallet" where a wallet would show, and the card watches for the link made in a wallet app (poll while visible).
// Phones live inside the wallet app (owner decision F4): on a phone's Safari / Chrome a member with a linked wallet sees "On this phone you
// buy in Phantom" with Connect Phantom (Vicinity opens inside Phantom, signed in there or one signature away); inside the wallet app the
// card says it is connected and gives the "next time" tip; for 7 days after a wallet joined from another app an older browser gets
// "Wasn't you? Remove it". Needs site.js (window.V) and wallets.js (window.VW). The city coin's ticker comes from /api/me alone
// (the chain's symbol once launched, else the city list's): this file never makes one up from the city's name.
(() => {
  "use strict";
  const { $, $$, el, api, toast, copy, fmt, compact, mask, short, ago, initials, getLocation, burst, reveal } = window.V;
  const W = window.VW;
  // the wallet app this person uses on this phone, and the one whose browser this is (site.js): null on a computer and in Safari
  const WA = window.V.walletApp || { here: () => null, remembered: () => null, remember() {} };
  const appNamed = (id) => (id && W.KNOWN.find((k) => k.id === id)) || null;
  /** The link that opens Vicinity inside the wallet app `k`, signed in there or one signature away (/connect?mode=login&with=<id>). */
  /** `next` = where to land there: a tab of this dashboard (/dashboard#profile), else the dashboard's home. */
  const openIn = (k, next = null) => k.open(`${location.origin}/connect?mode=login&with=${k.id}${next ? `&next=${encodeURIComponent(next)}` : ""}`);
  /** This page as a "next" for openIn: the dashboard and its tab (#profile), when that is what the address bar holds. */
  const hereNext = () => (location.pathname === "/dashboard" && /^#[a-z][a-z0-9-]{0,24}$/.test(location.hash) ? `/dashboard${location.hash}` : null);
  /** A phone's Safari or Chrome: no wallet in it, not a wallet app's own browser (the wallet app is where this person signs and buys). */
  const phoneBrowser = () => W.isMobile && !WA.here() && W.list().length === 0;
  /**
   * One chip per wallet app that can open this site (a tap remembers it), the three with real app links first (Phantom, Solflare,
   * Backpack), without `skip` (the app the main button already opens). For a phone that has not said which one it uses, or another one.
   */
  const UL_FIRST = ["phantom", "solflare", "backpack"];
  const appChips = (host, skip = null, next = null) => host.replaceChildren(...W.KNOWN.filter((k) => k.open && k.id !== skip)
    .sort((a, b) => (UL_FIRST.includes(b.id) ? 1 : 0) - (UL_FIRST.includes(a.id) ? 1 : 0)).map((k) => {
      const a = el("a", "chip-link", k.name); a.href = openIn(k, next); a.addEventListener("click", () => WA.remember(k.id)); return a;
    }));
  const params = new URLSearchParams(location.search);
  const LEVEL = { admin: "Admin", manager: "Country Manager", founder: "City Founder", holder: "Holder", member: "Member" };
  const REASONS = { spam: "Spam", scam: "Scam / fake token", abuse: "Abuse", illegal: "Illegal", off_topic: "Off topic", other: "Other" };
  const regionNames = (() => { try { return new Intl.DisplayNames(["en"], { type: "region" }); } catch { return null; } })();
  const countryName = (cc) => { try { return (regionNames && regionNames.of(cc)) || cc; } catch { return cc; } };
  // The ticker comes from the server alone (/api/me community.ticker: the chain's symbol once the coin is launched, else the city
  // list's). Nothing here makes one up from the city name: a city without one shows its name, with no "$", and its coin disc wears the
  // name's first letter (a ticker-sized disc cannot hold a name; the name stands beside it).
  const coinDisc = (c) => (c && c.ticker) || (c && c.name ? initials(c.name) : "");
  const coinLabel = (c) => (c && c.ticker ? `$${c.ticker}` : c && c.name ? c.name : "your city coin");
  const pctText = (p) => (p >= 10 ? p.toFixed(1) : p >= 0.01 ? p.toFixed(2) : "<0.01");
  /** A city ticker on a coin disc: the whole ticker, never cut; the disc gets its length (data-len) so the stylesheet steps the size down. */
  const discText = (span, tk) => { span.textContent = tk; const disc = span.parentNode; if (disc && disc.dataset) disc.dataset.len = String(Math.min(String(tk).length, 12)); };
  const date = (iso) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  const when = (iso) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const left = (iso) => { const ms = Date.parse(iso) - Date.now(); if (ms <= 0) return "closing now"; const h = Math.floor(ms / 3600000); return h >= 48 ? `${Math.floor(h / 24)} days left` : h >= 1 ? `${h}h left` : `${Math.ceil(ms / 60000)} min left`; };
  let me = null, checkedAt = 0;
  // the launch on our own launchpad (lpMount below): is it switched on here, asked once; the city whose launch card is shown
  let lpOn = false, lpProbed = false, lpCity = null;
  // the tabbed dashboard (DASHBOARD_V2=on): its code is fetched only when /api/me says so, and this stays null otherwise
  let v2 = null;
  const V2_KEY = "vicinity:dash-v2";

  const COMMON_ERR = {
    location_unverified: "We couldn't confirm your location. Turn on precise location (GPS) and use your normal home or mobile internet, with no VPN or proxy.",
    location_required: "We need a fresh location check for this. Please try again.",
    location_expired: "That location check expired (they last 5 minutes and work once). Please try again.",
    slow_down: "That's a lot of attempts. Take a break and try again later.",
    cities_unavailable: "The map is busy. Please try again in a minute.",
    home_locked: (d) => `You can change your home community once a week (next: ${date(d.until)}).`,
    founder_home_locked: "You can't move while you hold or are applying for a founder seat.",
    sign_in: "Your session ended. Please sign in again.",
    reprove: "Please confirm it's you with your wallet first.",
    link_new: (d) => `For your safety, for 7 days after connecting ${appWord(d.app)}, you do this in Safari or Chrome, where you logged in before.`,
    no_wallet: "Link a wallet first.",
    wallet_required: "Link a wallet first.",
    in_grace: "Your founder seat is in grace: hold the founder amount again to use moderation.",
    not_allowed: "Only the right moderator can do that.",
    needs_second_moderator: "That needs a second moderator: you can't confirm your own action.",
    needs_manager: "A confirmed hide can only be undone by the Country Manager or an admin.",
    reason_required: "Please give a reason (at least a few words).",
    own_post: "You can't do that on your own post.",
    not_found: "That's gone.",
  };
  const errText = (map, d, fallback) => { const f = map[d.error] || COMMON_ERR[d.error]; return typeof f === "function" ? f(d) : f || fallback; };
  /** "Phantom" for a KNOWN id, else "a wallet app" (the words of link_new). */
  function appWord(id) { const k = id && W.KNOWN.find((x) => x.id === id); return k ? k.name : "a wallet app"; }

  /* ---------- "confirm it's you" (sensitive actions) ---------- */
  let proofDone = null, proofTimer = null;
  function closeProof(ok) {
    clearTimeout(proofTimer);
    $("#proof-modal").hidden = true;
    if (proofDone) { const d = proofDone; proofDone = null; d(ok); }
  }
  /**
   * `hint` = the server's "reprove" answer. relogin: true (the 7 days after a wallet joined from another app, this browser was logged in
   * before: src/walletlink.js ownerFresh): logging in again here confirms it, and the wallet app is NOT offered (its sessions are the
   * ones locked for this, it would refuse).
   */
  function askProof(hint = {}) {
    return new Promise((resolve) => {
      proofDone = resolve;
      $("#proof-error").hidden = true;
      $("#proof-code").hidden = true; $("#proof-start").hidden = false;
      // an account without a wallet has nothing to sign with: its login IS its identity, so the person logs in again to confirm it
      const linked = Boolean(me && me.user && me.user.wallet), relogin = Boolean(linked && hint && hint.relogin);
      $("#proof-login").hidden = linked && !relogin; $("#proof-transfer").hidden = !linked || relogin;
      $("#proof-login").textContent = relogin ? "Log in again" : "Log in again to confirm it's you";
      const list = linked ? W.list() : [];
      // a phone's Safari / Chrome: the wallet app confirms (it opens this page there, signed in); without a remembered app, one chip each
      const phone = linked && phoneBrowser(), k = phone && !relogin ? WA.remembered() || appNamed(me.user.walletApp) : null;
      $("#proof-app").hidden = !k; $("#proof-app-line").hidden = !phone && !relogin; $("#proof-apps").hidden = !(phone && !k && !relogin);
      if (k) { $("#proof-app").textContent = `Open ${k.name}`; $("#proof-app").href = openIn(k, hereNext()); $("#proof-app").dataset.app = k.id; } // remembered on the tap (below)
      $("#proof-app-line").textContent = relogin ? `For 7 days after connecting ${appWord(me.user.walletApp)}, you confirm this here: log in again, then try once more.`
        : k ? `On this phone you confirm in ${k.name}. It opens this page there, logged in.` : "On this phone you confirm in your wallet app. Pick it: it opens this page there, logged in.";
      if (phone && !k && !relogin) appChips($("#proof-apps"), null, hereNext());
      $("#proof-none").hidden = (linked && list.length > 0) || phone || relogin;
      $("#proof-none").textContent = linked ? "No wallet found in this browser. Open this page in your wallet app, or use the tiny transfer below."
        : "Your account has no wallet yet, so there is nothing to sign with. Log in again to confirm it's you.";
      $("#proof-wallets").replaceChildren(...list.map((w) => {
        const b = el("button", "wallet-option"); b.type = "button";
        const icon = W.safeIcon(w.icon);
        if (icon) { const img = el("img"); img.alt = ""; img.src = icon; b.append(img); } else b.append(W.mark(w.name));
        b.append(el("span", null, w.name), el("span", "detected", "Sign"));
        b.addEventListener("click", () => signProof(w));
        return b;
      }));
      $("#proof-modal").hidden = false;
    });
  }
  const proofErr = (m) => { $("#proof-error").textContent = m; $("#proof-error").hidden = false; };
  async function signProof(w) {
    try {
      const address = await w.connect();
      if (address !== me.user.wallet) return proofErr(`That's a different wallet. Use the one on your account (${mask(me.user.wallet)}).`);
      const m = await api(`/api/message?address=${encodeURIComponent(address)}&action=login`);
      if (!m.message) return proofErr("Couldn't prepare the message. Try again.");
      const sig = await w.signMessage(new TextEncoder().encode(m.message));
      const r = await api("/api/auth/reprove", { address, message: m.message, signature: btoa(String.fromCharCode(...sig)) });
      if (!r.ok) return proofErr(r.error === "wrong_wallet" ? "That's not your account's wallet." : "Couldn't confirm. Try again.");
      toast("Confirmed ✓"); closeProof(true);
    } catch (e) { proofErr(/reject|cancel|denied/i.test(String(e?.message || e)) ? "Cancelled in your wallet." : "Couldn't connect. Try again."); }
  }
  $("#proof-start").addEventListener("click", async () => {
    const r = await api("/api/auth/transfer", { address: me.user.wallet, reprove: true });
    if (!r.ok) return proofErr(r.error === "slow_down" ? "Too many tries from your network right now. Wait a few minutes and try again." : "Couldn't start. Try again.");
    $("#proof-sol").textContent = r.sol; $("#proof-code").hidden = false; $("#proof-start").hidden = true;
    const poll = async () => {
      if ($("#proof-modal").hidden) return;
      const c = await api("/api/auth/transfer/check", {});
      if (c.ok) { toast("Transfer found ✓"); return closeProof(true); }
      // the amount is good for 30 minutes; after that the server drops it and the person gets a new one
      if (c.error === "expired" || c.error === "no_proof") { $("#proof-code").hidden = true; $("#proof-start").hidden = false; return proofErr("This code expired. Get a new one."); }
      // slow_down: the server wants fewer checks from this connection; ask every 30 seconds instead of 10
      proofTimer = setTimeout(poll, c.error === "slow_down" ? 30_000 : 10_000);
    };
    proofTimer = setTimeout(poll, 8000);
  });
  $("#proof-cancel").addEventListener("click", () => closeProof(false));
  $("#proof-login").addEventListener("click", async () => {
    const again = Boolean(me && me.user && me.user.wallet); // (the 7 days after a wallet joined from another app: say why on the Log in tab)
    closeProof(false); await api("/api/auth/logout", {}); location.assign(again ? "/connect?mode=login&error=relogin_confirm" : "/connect?mode=login");
  });
  /** Run a sensitive call; if the server asks, confirm with the wallet and try once more. An answer that needs a wallet points at the link card. */
  async function sensitive(call) {
    let r = await call();
    if (r && r.error === "reprove" && (await askProof(r))) r = await call();
    if (r && (r.error === "no_wallet" || r.error === "wallet_required")) linkFirst();
    return r;
  }
  /** Something needed a wallet: bring the link card into view and say so (the server's answer is shown by the caller too). */
  function linkFirst() {
    const card = $("#wallet-card");
    toast("Link a wallet first");
    if (card.hidden) return;
    if (v2) v2.goTo("#wallet-card"); else card.scrollIntoView({ block: "center", behavior: window.V.reduced ? "auto" : "smooth" });
  }

  /**
   * A location attestation for one purpose (the location itself never leaves this function except to /api/locate).
   * Inside a wallet app's browser, which often can't share GPS, the check is finished in the phone's normal browser.
   */
  async function locateFor(purpose) {
    let loc;
    try { loc = await getLocation(); }
    catch (e) { if (e.inApp) return locateInBrowser(purpose); throw e; }
    const r = await api("/api/locate", { location: loc, purpose });
    if (!r.ok) throw new Error(errText({}, r, "Couldn't check your location. Please try again."));
    return r;
  }

  let locateTimer = null, locateDone = null;
  function closeLocate(result, error) {
    clearTimeout(locateTimer);
    $("#locate-modal").hidden = true;
    if (locateDone) { const d = locateDone; locateDone = null; error ? d.reject(error) : d.resolve(result); }
  }
  /** Ask for a one-time link, wait for the phone's browser to answer it, and return the same thing /api/locate does. */
  async function locateInBrowser(purpose) {
    $("#locate-error").hidden = true;
    const h = await api("/api/locate/handoff", { purpose });
    if (!h.ok) throw new Error(errText({}, h, "Couldn't start. Please try again."));
    return new Promise((resolve, reject) => {
      locateDone = { resolve, reject };
      $("#locate-link").value = h.url;
      $("#locate-modal").hidden = false;
      const until = Date.parse(h.expiresAt), expired = () => closeLocate(null, new Error("That link expired. Please try again."));
      const poll = async () => {
        if ($("#locate-modal").hidden) return;
        if (Date.now() > until) return expired();
        const r = await api("/api/locate/handoff/claim", { code: h.code });
        if (r.ok) return closeLocate(r);
        if (r.status === "expired") return expired();
        locateTimer = setTimeout(poll, 2000);
      };
      locateTimer = setTimeout(poll, 2000);
    });
  }
  $("#locate-copy").addEventListener("click", () => copy($("#locate-link").value, "Link copied. Paste it in Safari or Chrome."));
  $("#locate-link").addEventListener("focus", (e) => e.target.select());
  $("#locate-cancel").addEventListener("click", () => closeLocate(null, new Error("Cancelled. Nothing was changed.")));

  /** What dashboard-roles.js needs from this file. */
  const roleCtx = { sensitive, refresh: () => refresh(), locateFor, errText, countryName };

  /* ---------- identity ---------- */
  const PROVIDER_LABEL = { google: "Google", email: "Email" };
  function identity(d) {
    const u = d.user, linked = Boolean(u.wallet), name = u.handle || u.name || (linked ? mask(u.wallet) : "Member");
    $$("[data-me-name]").forEach((e) => (e.textContent = name));
    // no wallet yet (onboarding v3): the pass says so and offers the link; Copy has nothing to copy
    $$("[data-me-wallet]").forEach((e) => { e.textContent = linked ? mask(u.wallet) : "No wallet linked"; e.classList.toggle("mono", linked); });
    // the pass shows the sign-in method only — never the real name (privacy)
    $$("[data-me-login]").forEach((e) => (e.textContent = PROVIDER_LABEL[u.provider] || "Google"));
    $("#me-avatar").textContent = initials(name);
    $("#me-copy").hidden = !linked; $("#me-link").hidden = linked || d.signupFlow !== "v2"; // (Link only while the new sign-up's link routes are on)
    $("#pass-ring").hidden = linked;
    if (!linked) ringSet($("#pass-ring"), d.setup, false);
    $("#ob-wallet").classList.toggle("is-ok", linked);
    $("#ob-wallet-title").textContent = linked ? "Wallet verified" : "Wallet: link it later, from your dashboard";
  }

  /* ---------- the setup ring: location, account, wallet (2 of 3 until a wallet is linked; /api/me setup) ---------- */
  const RING_LABEL = { location: "Location", account: "Account", wallet: "Wallet" };
  const SETUP_DEFAULT = { steps: [{ id: "location", done: true }, { id: "account", done: true }, { id: "wallet", done: false }] };
  const listOf = (a) => (a.length > 1 ? `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}` : a.join(""));
  /** Fill a ring (#welcome-ring or #pass-ring): the number, the ticks, the words for a screen reader, and the arc (a CSS variable; a sweep unless reduced motion). */
  function ringSet(host, setup, animate) {
    if (!host) return;
    const steps = (setup && Array.isArray(setup.steps) && setup.steps.length ? setup : SETUP_DEFAULT).steps;
    const done = steps.filter((x) => x.done), open = steps.filter((x) => !x.done);
    const num = host.querySelector(".ring__num"); if (num) num.textContent = `${done.length}/${steps.length}`;
    for (const x of steps) {
      const li = host.querySelector(`#${host.id}-tick-${x.id}`); if (!li) continue;
      li.classList.toggle("is-done", x.done); li.textContent = `${RING_LABEL[x.id] || x.id} ${x.done ? "done" : x.id === "wallet" ? "not linked yet" : "to do"}`;
    }
    const low = (x) => (RING_LABEL[x.id] || x.id).toLowerCase();
    host.setAttribute("aria-label", `Profile ${done.length} of ${steps.length} complete: ${listOf(done.map(low))} done${open.length ? `, ${listOf(open.map(low))} not linked` : ""}`);
    const to = String(Math.round((done.length / steps.length) * 1000) / 1000);
    if (animate && !window.V.reduced) { host.style.setProperty("--ring-done", "0"); requestAnimationFrame(() => requestAnimationFrame(() => host.style.setProperty("--ring-done", to))); }
    else host.style.setProperty("--ring-done", to);
  }

  /* ---------- the welcome moment (/dashboard?welcome=1, once) ---------- */
  const firstName = (u) => String(u.name || "").trim().split(/\s+/)[0] || (u.handle ? `@${u.handle}` : "");
  function showWelcome(d) {
    // an e-mail account has no name yet (the server calls it "E-mail member"): the card greets the city alone
    const u = d.user, c = d.community, box = $("#welcome"), who = u.provider === "email" ? "" : firstName(u);
    $("#welcome-title").textContent = `Welcome to ${u.home ? u.home.name : "Vicinity"}${who ? `, ${who}` : ""}.`;
    $("#welcome-line").textContent = (c && c.memberNumber ? `You are member #${fmt(c.memberNumber)} here. ` : "Your dashboard is live. ")
      + (u.wallet ? "Your profile is complete." : "Two of three steps done: link a wallet whenever you like.");
    if (c) discText($("#welcome-disc"), coinDisc(c)); else $("#welcome-disc").textContent = "📍";
    box.hidden = false;
    ringSet($("#welcome-ring"), d.setup, true);
    const r = box.getBoundingClientRect(); burst(r.left + 60, r.top + 40);
  }
  $("#welcome-close").addEventListener("click", () => { $("#welcome").hidden = true; if (v2) v2.placeCard(); });

  /* ---------- the link card (#wallet-card): a member without a wallet links one from here; it watches for a link made in a wallet app ---------- */
  const WCARD_SKIP = "vicinity:wcard-skip"; // this viewer folded the card (localStorage: a convenience, never state)
  let linkPoll = 0, linkPollUntil = 0, linkedNow = false; // linkedNow: the wallet arrived during this visit (the card stays as "Profile complete")
  const skipped = () => { try { return localStorage.getItem(WCARD_SKIP) === "1"; } catch { return false; } };
  const linkStarted = () => { try { return sessionStorage.getItem("vl-started") === "1"; } catch { return false; } }; // set by /connect's link mode in this tab
  /** The wallet app this person uses on this phone ("Phantom"): the one remembered here, else the one chosen on /connect in this tab. */
  const carryName = () => { const k = WA.remembered(); if (k) return k.name; try { return sessionStorage.getItem("su-carry") || ""; } catch { return ""; } };
  const TIP_OK = "vicinity:inapp-tip"; // this viewer put the "next time" tip away, inside the wallet app (localStorage: a convenience, never state)
  const tipDone = () => { try { return localStorage.getItem(TIP_OK) === "1"; } catch { return false; } };
  /**
   * "Connected 5m ago in Phantom (wallet Abcd…wxyz)." for a wallet that joined from another browser (/api/me walletNew). The app is what
   * the claiming browser SAID it was (a display hint): the masked wallet is what tells the owner whether it is theirs.
   */
  const connectedLine = (wn) => { const k = appNamed(wn.app); return `Connected ${ago(wn.at)}${k ? ` in ${k.name}` : " from a wallet app"} (wallet ${wn.wallet}).`; };
  /** The card's optional pieces start hidden on every draw; each way of the card shows its own. */
  function cardReset(card) {
    for (const id of ["#wcard-note", "#wcard-tip", "#wcard-apps", "#wcard-another", "#wcard-other", "#wcard-wait"]) $(id).hidden = true;
    $("#wcard-go").dataset.app = ""; $("#wcard-go").hidden = false; $("#wcard-lead").hidden = false;
    card.hidden = false;
  }
  function walletCard(d) {
    walletCardDraw(d);
    if (v2) v2.placeCard();
  }
  function walletCardDraw(d) {
    const card = $("#wallet-card"), u = d.user, wn = d.walletNew || null;
    card.dataset.place = "top";
    // the old sign-up is back (SIGNUP_FLOW off): its /connect cannot link a wallet to an existing account, so no card that leads there
    if (!u.wallet && d.signupFlow !== "v2") { stopLinkPoll(); card.hidden = true; return; }
    if (u.wallet) {
      stopLinkPoll();
      const inApp = WA.here();
      if (inApp) WA.remember(inApp.id); // signed in inside this wallet app: the one this person uses on this phone
      if (d.signupFlow === "v2" && phoneBrowser()) return buyCard(card, u, wn);
      if (inApp && (linkedNow || !tipDone())) return tipCard(card, u, inApp);
      if (linkedNow) {
        cardReset(card); card.classList.add("is-done", "wcard--folded");
        $("#wcard-kicker").textContent = "Profile complete · 3 of 3";
        $("#wcard-title").textContent = "Wallet linked ✓";
        $("#wcard-lead").textContent = `${short(u.wallet)} is the wallet of your account. Your holdings, rank and founder path are live.`;
        $("#wcard-perks").hidden = true; $("#wcard-actions").hidden = true; $("#wcard-tiny").hidden = false;
        if (wn && wn.notMe) noteLine(wn);
        return;
      }
      if (wn && wn.notMe) return noticeCard(card, wn); // a computer, after a wallet joined from a wallet app: is that you?
      card.hidden = true; return;
    }
    cardReset(card); card.classList.remove("is-done");
    $("#wcard-city").textContent = u.home ? u.home.name : "your city";
    // a phone's Safari / Chrome has no wallet in it: the button names the wallet app (the one remembered, else "wallet") and /connect opens it
    const phone = phoneBrowser(), k = phone ? WA.remembered() : null, app = carryName();
    const go = $("#wcard-go"), other = $("#wcard-other");
    if (phone) { go.textContent = k ? `Connect ${k.name}` : "Connect wallet"; go.href = k ? `/connect?mode=link&app=${encodeURIComponent(k.id)}` : "/connect?mode=link"; other.hidden = !k; }
    else { go.textContent = "Connect wallet"; go.href = "/connect?mode=link"; }
    const fold = skipped();
    card.classList.toggle("wcard--folded", fold);
    $("#wcard-perks").hidden = fold; $("#wcard-tiny").hidden = fold; $("#wcard-skip").hidden = fold; $("#wcard-actions").hidden = false;
    $("#wcard-kicker").textContent = fold ? "Your profile · 2 of 3" : "Complete your profile · 2 of 3";
    $("#wcard-title").textContent = "Connect your wallet";
    $("#wcard-lead").textContent = phone ? `${k ? k.name : "Your wallet app"} opens. Approve once, and you stay there, logged in.`
      : fold ? "Free, one signature. Unlocks your holdings, rank, badges and the founder path."
      : "Free: one signature, not a transaction. Vicinity never asks for your recovery phrase or private key.";
    const waiting = linkStarted();
    $("#wcard-wait").hidden = !waiting;
    if (waiting) { $("#wcard-wait-text").textContent = `Waiting for ${app || "your wallet"}…`; startLinkPoll(); } else stopLinkPoll();
  }
  /** A phone's Safari / Chrome, the wallet linked: this is where the person shops, inside the wallet app. One card, one habit: Connect Phantom. */
  function buyCard(card, u, wn) {
    const kept = WA.remembered(), k = kept || appNamed(u.walletApp), go = $("#wcard-go");
    card.dataset.place = wn && wn.notMe ? "top" : "buy"; // "was this you?" stands first on Home, as on a computer; else where the Buy card was
    // Safari lost what it remembered (7 days without a visit, a new phone): the app the account was linked in, kept again, so the Buy
    // panel's list of wallet apps (public/swap.js reads the same key) names the same app first as this card
    if (!kept && k) WA.remember(k.id);
    cardReset(card); card.classList.add("is-done"); card.classList.remove("wcard--folded");
    // ("Phantom connected ✓" only when nobody needs to ask "was this you?": while the notice shows, a neutral kicker; the note under the
    // button names the wallet itself. Never the wallet in the kicker: it is set in capitals, and a wallet address is case-sensitive.)
    $("#wcard-kicker").textContent = wn && wn.notMe ? "New wallet on your account" : wn ? `${k ? k.name : "Wallet"} connected ✓` : "Buy $VICINITY";
    $("#wcard-title").textContent = k ? `Buy in ${k.name}` : "Buy in your wallet app";
    $("#wcard-lead").textContent = k ? `Opens Vicinity inside ${k.name}, logged in. You buy there.` : "Pick the wallet app you use: it opens Vicinity there, logged in. You buy there.";
    $("#wcard-perks").hidden = true; $("#wcard-tiny").hidden = true; $("#wcard-skip").hidden = true; $("#wcard-actions").hidden = false;
    go.hidden = !k;
    if (k) { go.textContent = `Open ${k.name}`; go.href = openIn(k); go.dataset.app = k.id; }
    $("#wcard-another").hidden = !k; $("#wcard-another").setAttribute("aria-expanded", "false");
    appChips($("#wcard-apps"), k ? k.id : null); $("#wcard-apps").hidden = Boolean(k);
    if (wn && wn.notMe) noteLine(wn);
  }
  /** Inside the wallet app: connected, who is logged in, and how to come back here next time (until the person puts the tip away). */
  function tipCard(card, u, k) {
    cardReset(card); card.classList.add("is-done", "wcard--folded");
    card.dataset.place = "buy";
    $("#wcard-kicker").textContent = "Profile complete · 3 of 3";
    $("#wcard-title").textContent = `${k.name} connected ✓`;
    $("#wcard-lead").textContent = u.handle ? `You're logged in as @${u.handle}.` : "You're logged in.";
    $("#wcard-perks").hidden = true; $("#wcard-actions").hidden = true; $("#wcard-tiny").hidden = true;
    $("#wcard-tip-text").textContent = `Next time: open ${k.name}, open its browser and type vicinity.city. You'll still be logged in. Save it there to make it one tap.`;
    $("#wcard-tip").hidden = false;
  }
  /** A computer (or any older browser of the account) after a wallet joined from a wallet app: what joined, when, and "Remove it". */
  function noticeCard(card, wn) {
    cardReset(card); card.classList.add("is-done", "wcard--folded");
    $("#wcard-kicker").textContent = "New wallet on your account";
    $("#wcard-title").textContent = `Wallet ${wn.wallet} joined your account`;
    $("#wcard-lead").hidden = true; $("#wcard-perks").hidden = true; $("#wcard-actions").hidden = true; $("#wcard-tiny").hidden = true;
    noteLine(wn);
  }
  function noteLine(wn) { $("#wcard-note-text").textContent = `${connectedLine(wn)} Wasn't you?`; $("#wcard-note").hidden = false; }
  /** While a link started in this tab is open elsewhere (the wallet app's browser), ask /api/me?lite=1 every 4 s while this tab is on screen, and at once when it comes back. */
  function startLinkPoll() {
    if (linkPoll) return;
    linkPollUntil = Date.now() + 15 * 60_000;
    linkPoll = setInterval(linkTick, 4000);
    document.addEventListener("visibilitychange", onLinkVisible);
    linkTick();
  }
  function stopLinkPoll() {
    if (!linkPoll) return;
    clearInterval(linkPoll); linkPoll = 0;
    document.removeEventListener("visibilitychange", onLinkVisible);
  }
  function onLinkVisible() { if (document.visibilityState === "visible") linkTick(); }
  async function linkTick() {
    if (!me || me.user.wallet || !linkStarted()) return stopLinkPoll();
    if (Date.now() > linkPollUntil) { try { sessionStorage.removeItem("vl-started"); } catch {} $("#wcard-wait").hidden = true; return stopLinkPoll(); }
    if (document.visibilityState !== "visible") return;
    const r = await api("/api/me?lite=1");
    if (r && r.signedIn && r.user && r.user.wallet) await walletLinked(r.user.wallet, r.user.walletApp);
  }
  /** The wallet arrived (the poll saw it): the ring sweeps to 3 of 3, a burst, a toast, then everything is drawn again from /api/me. */
  async function walletLinked(wallet, appId) {
    stopLinkPoll();
    try { sessionStorage.removeItem("vl-started"); } catch {}
    linkedNow = true;
    const k = appNamed(appId); if (k) WA.remember(k.id); // the app that really linked it
    if (me) { me.user.wallet = wallet; me.setup = { percent: 100, steps: SETUP_DEFAULT.steps.map((x) => ({ ...x, done: true })) }; }
    if (!$("#welcome").hidden) ringSet($("#welcome-ring"), me && me.setup, true);
    toast(k ? `Wallet ${short(wallet)} connected in ${k.name} ✓` : `Wallet ${short(wallet)} linked ✓`); // (the wallet itself: the app is only what the other side said)
    const r = $("#wallet-card").getBoundingClientRect(); burst(r.left + r.width / 2, r.top + 40);
    await refresh();
  }
  $("#wcard-skip").addEventListener("click", () => {
    try { localStorage.setItem(WCARD_SKIP, "1"); } catch {}
    if (me) walletCard(me);
    toast("No problem. Link is on your pass whenever you want it.");
  });
  // "Connect Phantom" / "Open Phantom": the tap remembers the app this phone uses (data-app: set by the card or the proof, "" = nothing to remember)
  for (const id of ["#wcard-go", "#proof-app"]) $(id).addEventListener("click", (e) => WA.remember(e.currentTarget.dataset.app));
  $("#wcard-another").addEventListener("click", (e) => { const open = $("#wcard-apps").hidden; $("#wcard-apps").hidden = !open; e.currentTarget.setAttribute("aria-expanded", String(open)); });
  $("#wcard-tip-ok").addEventListener("click", () => { try { localStorage.setItem(TIP_OK, "1"); } catch {} linkedNow = false; if (me) walletCard(me); });
  // "Wasn't you? Remove it": the server takes the wallet off and logs out every other browser (src/walletlink.js handleDisown)
  const DISOWN_ERR = {
    not_allowed: "Only a browser you were logged in on before the wallet joined can do this. Tap Feedback and we'll help.",
    too_late: "It's been more than 7 days. Tap Feedback and we'll help.",
    seat_or_application: "A seat or an application from before depends on this wallet. Tap Feedback and we'll help.",
  };
  $("#wcard-remove").addEventListener("click", () => removeWallet());
  /** "Remove it" (the card's link, and Profile's Unlink during those 7 days, from a browser that may: walletNew.notMe). */
  async function removeWallet() {
    const wn = me && me.walletNew; if (!wn) return;
    const k = appNamed(wn.app);
    if (!confirm(`Remove this wallet (${wn.wallet}) from your account? ${k ? k.name : "The wallet app"} will be logged out of Vicinity.`)) return;
    const r = await api("/api/me/wallet/disown", {});
    if (r.ok) { toast(r.passwordCleared ? "Wallet removed. Other browsers are logged out. Set a new password with “Forgot password”." : "Wallet removed. Other browsers are logged out."); linkedNow = false; await refresh(); return; }
    if (r.error === "relogin") { await api("/api/auth/logout", {}); location.assign("/connect?mode=login&error=relogin"); return; } // a fresh login first (a stolen old cookie can't)
    toast(DISOWN_ERR[r.error] || errText({}, r, "Couldn't remove it. Tap Feedback and we'll help."));
  }

  /* ---------- first visit ---------- */
  function onboard(d) {
    $("#dash-onboard").hidden = false;
    const li = $("#ob-rank"), t = $("#ob-rank-text"), h = d.holding;
    li.classList.toggle("is-ok", Boolean(d.user.wallet));
    if (!d.user.wallet) t.textContent = "Link a wallet from your dashboard to see your position among all holders. Free, one signature.";
    else if (!d.launched) t.textContent = "Ranks go live the moment $VICINITY launches. You joined before launch: 🌱 Early member badge unlocked.";
    else if (h.rank) t.textContent = `#${fmt(h.rank)} of ${fmt(h.total)} holders · top ${pctText(h.percentile)}% · ${fmt(h.amount)} $VICINITY`;
    else if (h.team) t.textContent = `${fmt(h.amount)} $VICINITY · team wallet, not ranked`;
    else if (h.amount > 0) t.textContent = `${fmt(h.amount)} $VICINITY`;
    else t.textContent = "This wallet doesn't hold $VICINITY yet. You can still join your city; holding unlocks posting, voting and your rank.";
    $("#ob-locate").addEventListener("click", findHome);
    $("#ob-enter").addEventListener("click", () => location.assign("/dashboard"));
  }
  async function setHome(attestation, choice) {
    const d = await api("/api/home", { attestation, ...(choice ? { choice } : {}) });
    if (!d.ok) throw new Error(errText({ choose_nearby: "Please pick one of the three nearest communities." }, d, "Couldn't set your community."));
    const li = $("#ob-city");
    li.classList.remove("is-busy", "is-bad"); li.classList.add("is-ok");
    $("#ob-city-text").textContent = `${d.joinedNearby ? "You joined" : "You're in"} ${d.home.name} ✓ (your location wasn't saved)`;
    $("#ob-nearby").hidden = true; $("#ob-locate").hidden = true; $("#ob-enter").hidden = false;
    const r = li.getBoundingClientRect(); burst(r.left + 40, r.top);
  }
  async function findHome() {
    const li = $("#ob-city"), err = $("#ob-error");
    li.classList.remove("is-bad"); li.classList.add("is-busy"); err.hidden = true;
    $("#ob-locate").disabled = true;
    try {
      const r = await locateFor("home");
      if (r.city) return await setHome(r.attestation);
      li.classList.remove("is-busy");
      $("#ob-city-text").textContent = "You're not inside a community yet. Join one of the three nearest (this location check lasts 5 minutes):";
      $("#ob-locate").hidden = true;
      const ul = $("#ob-nearby"); ul.hidden = false;
      ul.replaceChildren(...r.nearby.map((c) => {
        const b = el("button", "city-row"); b.type = "button";
        const nm = el("span", "city-row__name"); nm.append(el("strong", null, c.name), el("span", null, `about ${c.km} km away`));
        b.append(nm, el("span", "tag tag--ok", "Join"));
        b.addEventListener("click", () => setHome(r.attestation, c.id).catch((e) => { err.textContent = e.message; err.hidden = false; }));
        const x = el("li"); x.append(b); return x;
      }));
    } catch (e) {
      li.classList.remove("is-busy"); li.classList.add("is-bad");
      err.textContent = e.message; err.hidden = false;
    } finally { $("#ob-locate").disabled = false; }
  }

  /* ---------- the dashboard ---------- */
  const BADGE_NAMES = {};
  function render(d) {
    me = d; checkedAt = Date.now();
    $("#me-checked").textContent = "Live"; // just checked (the clock below says how long ago, every 5 s)
    identity(d);
    walletCard(d);
    const u = d.user, h = d.holding, home = u.home, c = d.community, n = d.national, linked = Boolean(u.wallet);
    const pill = $("#me-role"); pill.textContent = d.roles.steward && d.level === "founder" ? "Seed Steward" : LEVEL[d.level] || "Member"; pill.dataset.level = d.level;
    $("#me-home").textContent = home ? `${home.name}, ${countryName(home.country)}` : "No home community yet";
    $$("[data-policy-version]").forEach((e) => (e.textContent = d.policyVersion));

    // without a wallet there is nothing to hold or rank: the two tiles point at the link instead
    $("#d-amount").textContent = d.launched && linked ? compact(h.amount) : "—";
    $("#d-amount-sub").textContent = !linked ? "link a wallet" : d.launched ? `${fmt(h.amount)} $VICINITY` : "live at launch";
    $("#d-rank").textContent = h.rank ? `#${fmt(h.rank)}` : "—";
    $("#d-rank-sub").textContent = h.rank ? `of ${fmt(h.total)} holder${h.total === 1 ? "" : "s"}` : !linked ? "link a wallet" : d.launched ? (h.team ? "team wallet, not ranked" : h.amount > 0 ? "ranking…" : "not holding yet") : "live at launch";
    $("#d-city-label").textContent = home ? home.name : "your city";
    $("#d-country-label").textContent = n ? countryName(n.country) : "your country";
    $("#d-crank").textContent = c && c.rank ? `#${c.rank}` : "—";
    $("#d-crank-sub").textContent = c ? (c.rank ? `of ${fmt(c.holders)} holder${c.holders === 1 ? "" : "s"} here` : `${fmt(c.members)} member${c.members === 1 ? "" : "s"}`) : "";
    $("#d-nrank").textContent = n && n.rank ? `#${n.rank}` : "—";
    $("#d-nrank-sub").textContent = n ? (n.rank ? `of ${fmt(n.holders)} holder${n.holders === 1 ? "" : "s"}` : `${fmt(n.members)} member${n.members === 1 ? "" : "s"}`) : "";

    // notices: a ban (with appeal), badges lost to a sale
    const ban = $("#ban-notice");
    if (d.ban) {
      ban.replaceChildren(el("span", null, `🚫 You can't post${d.ban.country === "*" ? "" : " in this country"} until ${date(d.ban.until)} (approved by two moderators). `));
      if (d.ban.actionId && !d.ban.appealed) ban.append(actBtn("Appeal", () => appeal(d.ban.actionId)));
      else if (d.ban.appealed) ban.append(el("span", "muted", "Your appeal is waiting for someone who wasn't involved."));
      ban.hidden = false;
    } else ban.hidden = true;
    for (const b of d.badges) BADGE_NAMES[b.id] = b.name;
    const alert = $("#lost-alert");
    const seat = d.founder.seat;
    if (seat && seat.status === "grace") {
      alert.textContent = `⚠️ Your founder seat for ${seat.city} is in grace until ${when(seat.graceUntil)}. Hold ${fmt(seat.threshold)} $VICINITY again or the seat reopens. Moderation is paused meanwhile.`;
      alert.hidden = false;
    } else if (d.lost.length) {
      const names = d.lost.map((id) => BADGE_NAMES[id] || id);
      alert.textContent = `⚠️ Badge${names.length > 1 ? "s" : ""} removed after your balance dropped: ${names.join(", ")}. Hold again to earn ${names.length > 1 ? "them" : "it"} back.`;
      alert.hidden = false;
    } else alert.hidden = true;

    window.VRole.render(d, roleCtx);
    if (layoutEditing) layoutSetEdit(true); // a card that just appeared (role panel, squad) gets its drag bar too
    renderPath(d);
    renderCommunity(d);
    renderCountry(d);
    renderBadges(d);
    loadCoin();
    $$(".role-row").forEach((r) => r.classList.toggle("is-you", r.dataset.role === d.level));
    $("#f-city").textContent = home ? home.name : "Local";
    $("#f-country").textContent = n ? countryName(n.country) : "National";
    if (d.profilesFlag) { profilesSync(d); linkName($("#cc-founder"), c && c.seat && !c.seat.you ? c.seat : null); linkName($("#nc-manager"), n && n.manager && !n.manager.you ? n.manager : null); }
    if (v2) v2.render(d);
  }

  /* ---------- member profiles: the code is fetched ONLY when /api/me says profilesFlag, so with the switch off this page never asks for it ---------- */
  let profiles = null, profilesAsked = false;
  function profilesSync(d) {
    if (profiles) return profiles.render(d);
    if (profilesAsked) return;
    profilesAsked = true;
    const s = document.createElement("script");
    s.src = "/profile.js";
    s.onload = () => { profiles = window.VProfile.dashboard({ me: () => me, sensitive }); profiles.render(me); };
    s.onerror = () => { profilesAsked = false; }; // the next refresh tries again
    document.head.append(s);
  }
  const HANDLE = /^[A-Za-z][A-Za-z0-9_]{2,19}$/;
  /**
   * A member's name as a link to their profile page, else as plain text. A link only with the switch on AND when the server
   * said the name is that member's username (`handle`, sent next to `name` while profiles are on; null for a member without
   * one): a display name that merely looks like a username would open a stranger's profile, or none.
   */
  const memberLink = (name, handle, tag = "b") => {
    if (!(me && me.profilesFlag && typeof handle === "string" && HANDLE.test(handle))) return el(tag, null, name);
    const a = el("a", "member-link", name); a.href = `/profile?u=${encodeURIComponent(handle)}`;
    if (tag === "b") { const b = el("b"); b.append(a); return b; }
    return a;
  };
  /** Turn the name of `who` ({ name, handle }: a seat or a manager) inside the text of `host` into that link. */
  function linkName(host, who) {
    if (!host || !who || !who.name || !(me && me.profilesFlag && typeof who.handle === "string" && HANDLE.test(who.handle))) return;
    const t = host.textContent, i = t.indexOf(who.name);
    if (i >= 0) host.replaceChildren(t.slice(0, i), memberLink(who.name, who.handle, "a"), t.slice(i + who.name.length));
  }

  const actBtn = (label, fn, cls = "link-btn") => { const b = el("button", cls, label); b.type = "button"; b.addEventListener("click", fn); return b; };
  /** A short label led by a line icon of the shared set (the tabbed dashboard: no emoji as icons); the flag-off page keeps its emoji. */
  const labelled = (node, icon, emoji, text) => {
    node.replaceChildren(...(v2 && window.VRole ? [window.VRole.icon(icon, { tone: "bare", fallback: emoji }), String(text)] : [`${emoji} ${text}`]));
    return node;
  };

  /* ---------- founder path ---------- */
  /** Why someone can't endorse, vote or challenge (the same checks the server makes for verified locals). */
  const VOTER_WHY = {
    not_local: "Only people whose home is this city can do this.", account_too_new: "Your account had to be 7+ days old when this opened.",
    home_too_new: "Your home had to be set 7+ days before this opened.", needs_checkin: "Check in once from inside your city first (proof you're really here).", banned: "You can't do this while banned.",
  };
  const APPLY_ERR = { not_in_city: (d) => d.here ? `You're in ${d.here} right now, not your home city.` : "You're not inside your city right now.", no_addresses: "No contract addresses in your pitch, please.",
    city_taken: "Someone just became founder here.", already_applied: "You've already applied.", not_dark: "That city isn't dark long enough yet.",
    window_closing: "This city's window has ended and is being decided. Try again in a few minutes." };

  /** "Oct 16" (no year, never broken across lines): the dates of the founder path. */
  const day = (iso) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" }).replace(" ", "\u00a0");
  function renderPath(d) {
    const p = d.progress, f = d.founder, home = d.user.home, c = d.community;
    $("#p-city").textContent = home ? home.name : "your city";
    $("#p-pct").textContent = `${p.percent}%`;
    requestAnimationFrame(() => ($("#p-bar").style.width = `${p.percent}%`));
    $("#p-steps").replaceChildren(...p.steps.map((s) => {
      const li = el("li", s.done ? "is-ok" : "");
      li.append(el("span", "req__dot"), el("span", null, s.label));
      if (s.id === "hold" && !s.done && s.progress > 0) { const m = el("span", "mini"), fill = el("span"); fill.style.width = `${Math.round(s.progress * 100)}%`; m.append(fill); li.append(m); }
      // (a date in the server's detail, "probation until 2026-12-29", reads "Dec 29" like the rest of the path)
      if (s.detail && !s.done) li.append(el("span", "detail", String(s.detail).replace(/\b(\d{4}-\d{2}-\d{2})\b/g, (x) => day(`${x}T12:00:00Z`))));
      return li;
    }));

    const panel = $("#p-panel");
    const T = f.threshold ? fmt(f.threshold) : "the founder amount of";
    const say = (...nodes) => { const x = el("p", "small"); x.append(...nodes); return x; };
    const parts = [];
    if (f.seat) {
      const s = f.seat;
      if (s.status === "provisional") parts.push(say(`🎉 ${s.city} chose you! Locals can object until ${when(s.appealUntil)}; if no objection is upheld, you're the founder.`));
      else if (s.status === "steward") parts.push(say(`🌟 You're ${s.city}'s Seed Steward: probation until ${day(s.probationUntil)}, or sooner once enough verified local holders back the city. Locals can challenge you.`));
      else if (s.status === "active") parts.push(say(`👑 You're the founder of ${s.city}. Keep ${fmt(s.threshold)} $VICINITY: if you drop below, moderation pauses at once and you have 7 days to fix it.`));
      else if (s.status === "grace") parts.push(say(`⚠️ Grace until ${when(s.graceUntil)}: hold ${fmt(s.threshold)} $VICINITY again or ${s.city}'s seat reopens.`));
    } else if (f.application) {
      parts.push(say(`📨 You applied. The window closes ${when(f.application.closesAt)} (${left(f.application.closesAt)}). Then everyone is scored by the published formula.`));
      parts.push(actBtn("Withdraw my application", async () => {
        if (!confirm("Withdraw your application? Your endorsements are removed.")) return;
        const r = await api("/api/seats/withdraw", {});
        toast(r.ok ? "Withdrawn" : errText({}, r, "Couldn't withdraw.")); refresh();
      }));
    } else if (!d.launched) {
      parts.push(say("Applications open after $VICINITY launches, once you've held your city's founder amount for 7 days in a row. The first qualified claimer becomes Seed Steward at once; if rivals claim together, a 72-hour window decides."));
    } else if (f.eligible) {
      const challenge = Boolean(f.challenging);
      const label = challenge ? `Challenge ${c && c.seat ? c.seat.name : "the steward"} (checks your location)` : `Apply to found ${home.name} (checks your location)`;
      const form = el("form", "apply-form");
      const ta = el("textarea"); ta.maxLength = 280; ta.rows = 2; ta.placeholder = challenge ? `Why should locals pick you over ${c && c.seat ? c.seat.name : "the steward"}? (optional, locals see this)` : `Why should you found ${home.name}? (optional, locals see this)`; ta.setAttribute("aria-label", "Your pitch");
      const go = el("button", "btn btn--primary btn--block", label); go.type = "submit";
      form.append(ta, go);
      form.addEventListener("submit", async (e) => {
        e.preventDefault(); showErr("#p-error", "");
        go.disabled = true; go.textContent = "Checking your location…";
        try {
          const r = await sensitive(async () => api("/api/seats/apply", { attestation: (await locateFor("apply")).attestation, pitch: ta.value.trim() }));
          if (!r.ok) throw new Error(errText(APPLY_ERR, r, "Couldn't apply. Please try again."));
          toast(r.steward ? `🌟 You're ${home.name}'s Seed Steward` : r.challenge ? `📨 Challenge opened: 72 hours` : `📨 Applied to found ${home.name}`);
          const b = go.getBoundingClientRect(); burst(b.left + b.width / 2, b.top); refresh();
        } catch (x) { showErr("#p-error", x.message); }
        finally { go.disabled = false; go.textContent = label; }
      });
      parts.push(say(challenge
        ? `✅ You qualify to challenge ${c && c.seat ? c.seat.name : "the steward"}, ${home.name}'s Seed Steward. If 10 verified locals endorse you within 72 hours, an election is forced (the steward defends the seat in it).`
        : `✅ You qualify: held ${T} $VICINITY for 7 days. Apply from inside ${home.name}: you become Seed Steward at once if nobody else is claiming. If rivals claim together, a 72-hour window scores everyone, locals' endorsements first.`), form);
    } else {
      const why = {
        no_home: "Set your home community first.",
        home_too_new: `Your home community must be set 7 days before applying: ready ${f.homeReadyAt ? day(f.homeReadyAt) : "soon"}.`,
        not_qualified: f.tenure && f.tenure.days > 0
          ? `Held ${T} for ${Math.floor(f.tenure.days)} of 7 days. Balances are checked at random times, about every hour: hold through all of them.`
          : `Hold ${T} $VICINITY to start your 7-day clock. Balances are checked at random times, so borrowed tokens don't help.`,
        below_threshold: `Hold ${T} $VICINITY right now to apply.`,
        cooldown: `You can apply again on ${f.cooldownUntil ? day(f.cooldownUntil) : "soon"} (30 days after losing a seat).`,
        city_taken: f.whyNot ? `${home ? home.name : "Your city"} has a Seed Steward on probation. To challenge them: ${VOTER_WHY[f.whyNot] || "you need to be a verified local."}` : `${home ? home.name : "Your city"} already has a founder.`,
        banned: "You can't apply while banned.",
        has_seat: "You already hold a seat.", already_applied: "You've already applied.",
      }[f.why];
      if (why) parts.push(say(why));
    }
    // the city's seat, if it's someone else's
    if (c && c.seat && !c.seat.you) {
      const s = c.seat;
      const line = say(`${s.status === "provisional" ? "Chosen" : s.status === "steward" ? "Seed Steward" : "Founder"}: ${s.handle ? s.name : `${s.name} (${s.wallet})`} since ${day(s.since)}`);
      if (s.status === "provisional") line.append(` · objections until ${when(s.appealUntil)}`);
      if (s.status === "steward") line.append(` · probation until ${day(s.probationUntil)}${s.quorum ? ` · ${s.quorum.have}/${s.quorum.need} local holders` : ""}`);
      if (s.status === "grace") line.append(" · in grace");
      if (s.openObjections) line.append(` · ${s.openObjections} objection${s.openObjections === 1 ? "" : "s"} under review`);
      parts.push(line, actBtn("Object to this founder", () => objectTo(s.id, s.name)));
    }
    if (c && c.lastResult) {
      const a = el("a", "tiny", "How the last window was decided (published result + hash) ↗");
      a.href = `/api/seats/results/${c.lastResult.windowId}`; a.target = "_blank"; a.rel = "noopener";
      parts.push(say(a));
    }
    panel.replaceChildren(...parts);
    renderWindow(d);
  }
  async function objectTo(seatId, name) {
    const reason = prompt(`Why should ${name} not be the founder? (at least 10 characters; an admin reviews it)`);
    if (!reason) return;
    const r = await api("/api/seats/object", { seatId, reason });
    toast(r.ok ? "Objection sent to an admin for review" : errText({ already_objected: "You've already objected.", not_local: "Only locals can object." }, r, "Couldn't send."));
    if (r.ok) refresh();
  }

  function renderWindow(d) {
    const box = $("#p-window"), c = d.community, w = c && c.window;
    if (!w) { box.hidden = true; return; }
    box.hidden = false;
    const why = {
      applicant: "You're applying, so you can't endorse.",
      not_local: "Only people whose home is this city can endorse.",
      account_too_new: "To endorse, your account had to be 7+ days old when this window opened.",
      home_too_new: "To endorse, your home had to be set 7+ days before this window opened.",
      needs_checkin: `Check in once from inside ${c.name} to endorse (proof you're really here).`,
      banned: "You can't endorse while banned.",
    }[w.whyNot];
    const head = el("div", "window-panel__head");
    head.append(el("strong", null, `${w.applicants.length} applying to found ${c.name}`), el("span", "tag tag--warn", left(w.closesAt)));
    const list = el("ul", "applicants");
    for (const a of w.applicants) {
      const li = el("li", a.you ? "is-you" : "");
      const who = el("div");
      who.append(el("strong", null, a.you ? `${a.name} (you)` : a.name));
      if (a.pitch) who.append(el("p", "small muted", `“${a.pitch}”`));
      li.append(who, el("span", "applicants__n", `${a.endorsements} endorsement${a.endorsements === 1 ? "" : "s"}`));
      if (w.myEndorsement === a.id) li.append(el("span", "tag tag--ok", "✓ Your endorsement"));
      else if (w.canEndorse && !a.you) li.append(actBtn("Endorse", async () => {
        const r = await sensitive(() => api("/api/seats/endorse", { applicationId: a.id }));
        toast(r.ok ? `You endorsed ${a.name}` : errText({ window_closed: "The window has closed." }, r, "Couldn't endorse.")); if (r.ok) refresh();
      }, "btn btn--glass btn--sm"));
      list.append(li);
    }
    const note = el("p", "tiny muted", "One endorsement per person (you can change it until the window closes). Final score: 50% endorsements, 30% contribution, 20% holdings capped at 2× the founder amount.");
    box.replaceChildren(head, list, ...(why ? [el("p", "small muted", why)] : []), note);
  }

  function renderCommunity(d) {
    const c = d.community;
    if (!c) return;
    const tk = coinDisc(c);
    discText($("#cc-face"), tk);
    discText($("#pass-coin"), tk);
    $("#cc-name").textContent = c.name;
    tickerLine();
    $("#cc-members").textContent = fmt(c.members);
    $("#cc-holders").textContent = d.launched ? (c.holders != null ? fmt(c.holders) : "…") : "At launch";
    $("#cc-founder").textContent = c.seat ? (c.seat.you ? `You 👑${c.seat.status !== "active" ? ` (${c.seat.status})` : ""}` : `${c.seat.name}${c.seat.status !== "active" ? ` (${c.seat.status})` : ""}`)
      : c.window ? `Choosing · ${c.window.applicants.length} applying` : "Open seat 🔥";
    const others = c.members - 1;
    $("#cc-fomo").textContent = c.seat && c.seat.you
      ? `You're ${c.name}'s founder. Bring your locals in, and design ${c.name}'s coin so they can see what's coming.`
      : c.seat
      ? `${c.name} has a founder. Climb the local board: the top holders here are the first people the city sees.`
      : c.window ? `${c.name} is choosing its founder right now (${left(c.window.closesAt)}). Locals' endorsements count most.`
      : others <= 0 ? `You're the first member of ${c.name}. Bring your locals in: they're the ones who choose the founder.`
      : `${fmt(others)} other ${others === 1 ? "person" : "people"} from ${c.name} ${others === 1 ? "is" : "are"} here, and nobody has applied to found it yet.`;
    $("#cc-top").replaceChildren(...(c.top && c.top.length ? c.top.map((t) => { const li = el("li", t.you ? "is-you" : ""); li.append(el("span", "mono", t.you ? "You" : t.wallet), el("span", "amt", compact(t.amount))); return li; })
      : [el("li", "muted small", d.launched ? "No holders here yet. Be the first." : "Live at launch.")]));
  }
  /** "$UTICA · city coin · United States" (the city's name when it has no ticker yet); "preview" while the city's coin is not live yet. */
  function tickerLine() {
    const c = me && me.community; if (!c) return;
    $("#cc-ticker").textContent = `${coinLabel(c)} · city coin${coinData && coinData.launched ? "" : " preview"} · ${countryName(c.country)}`;
  }
  $("#cc-share").addEventListener("click", () => {
    const name = me?.community?.name || "my city";
    copy(`I'm repping ${name} on Vicinity. One city, one coin, chosen by locals: join us → ${location.origin}/connect`, "Invite copied. Send it to your locals!");
  });

  function renderCountry(d) {
    const n = d.national;
    if (!n) return;
    $("#nc-name").textContent = countryName(n.country);
    $("#nc-members").textContent = fmt(n.members);
    $("#nc-manager").textContent = n.manager ? `${n.manager.you ? "You 🛡️" : n.manager.name} · ${n.manager.city}${n.manager.paused ? " (paused)" : ""} · until ${date(n.manager.endsAt)}`
      : d.launched ? "None yet: elected from founders with 30+ days" : "Elected after launch";
    const box = $("#nc-election"), e = n.election;
    if (!e) { box.hidden = true; return; }
    box.hidden = false;
    const why = { not_local: "Only people whose home is in this country can vote.", account_too_new: "To vote, your account had to be 7+ days old when the election opened.",
      home_too_new: "To vote, your home had to be set 7+ days before the election opened.", needs_checkin: "Check in once from your community to vote.", banned: "You can't vote while banned." }[e.whyNot];
    const list = el("ul", "applicants");
    for (const cnd of e.candidates) {
      const li = el("li", cnd.you ? "is-you" : "");
      const who = el("div"); who.append(el("strong", null, cnd.you ? `${cnd.name} (you)` : cnd.name), el("p", "small muted", `Founder of ${cnd.city}`));
      li.append(who, el("span", "applicants__n", `${cnd.votes} vote${cnd.votes === 1 ? "" : "s"}`));
      if (e.myVote === cnd.seatId) li.append(el("span", "tag tag--ok", "✓ Your vote"));
      else if (e.canVote) li.append(actBtn("Vote", async () => {
        const r = await sensitive(() => api("/api/elections/vote", { electionId: e.id, seatId: cnd.seatId }));
        toast(r.ok ? `You voted for ${cnd.name}` : errText({ election_closed: "The election has closed." }, r, "Couldn't vote.")); if (r.ok) refresh();
      }, "btn btn--glass btn--sm"));
      list.append(li);
    }
    box.replaceChildren(el("p", "kicker kicker--live", `Election open · ${left(e.closesAt)}`), list, ...(why ? [el("p", "small muted", why)] : []),
      el("p", "tiny muted", "One vote per person. Score: 50% votes, 30% service, 20% holdings capped at 2×. 90-day term."));
  }

  let btab = "earned";
  const WALLET_BADGES = new Set(["holder", "founder_ready", "whale", "top100", "top10"]); // badges a wallet's holdings earn
  const BADGE_ICON = { early: "rocket", verified: "check", wallet: "link", local: "pin", holder: "coin", founder_ready: "idcard", whale: "wallet", top100: "star", top10: "trophy",
    city_founder: "crown", country_manager: "shield", voice: "chat", streak: "chart", admin: "shield" };
  const TOP_BADGES = new Set(["city_founder", "country_manager", "top100", "top10", "admin", "whale"]); // founder or top: gold
  function badgeEl(d, b) {
    const lost = d.lost.includes(b.id);
    const li = el("li", `badge ${b.earned ? "is-earned" : lost ? "is-lost" : "is-locked"}`);
    li.title = `${b.name}: ${b.detail}${b.earned ? " ✓" : ""}`;
    li.tabIndex = 0;
    const art = v2 && BADGE_ICON[b.id] ? window.VRole.icon(BADGE_ICON[b.id], { small: false, tone: !b.earned ? "muted" : TOP_BADGES.has(b.id) ? "gold" : "ok", fallback: b.icon }) : el("span", "badge__icon", b.icon);
    li.append(art, el("span", "badge__name", b.grace ? `${b.name} (grace)` : b.name));
    if (!b.earned && !d.user.wallet && WALLET_BADGES.has(b.id)) li.append(el("span", "badge__pending", "needs a wallet"));
    else if (!b.earned && b.progress > 0) {
      const p = el("span", "badge__prog"), f = el("span");
      f.style.width = `${Math.round(b.progress * 100)}%`; p.append(f); li.append(p);
      li.append(el("span", "badge__pending", "◐ In progress"));
    }
    li.addEventListener("click", () => toast(`${b.icon} ${b.name}: ${b.detail}`));
    return li;
  }
  function renderBadges(d) {
    const earned = d.badges.filter((b) => b.earned), locked = d.badges.filter((b) => !b.earned);
    $("#bg-n-earned").textContent = earned.length;
    $("#bg-n-locked").textContent = locked.length;
    const list = btab === "earned" ? earned : locked;
    $("#badge-grid").replaceChildren(...list.map((b) => badgeEl(d, b)));
    if (!list.length) $("#badge-grid").append(el("li", "muted small", btab === "earned" ? "Nothing earned yet — your first badges are waiting." : "Everything achieved. Nice."));
  }
  $$("[data-btab]").forEach((b) => b.addEventListener("click", () => {
    btab = b.dataset.btab;
    $$("[data-btab]").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    if (me) renderBadges(me);
  }));

  const showErr = (sel, msg) => { const e = $(sel); e.textContent = msg || ""; e.hidden = !msg; };

  /* ---------- feeds ---------- */
  let scope = "city", kind = "meme", sort = "new", oldest = 0, loading = false, picture = null;
  const PLACEHOLDER = { meme: "Caption a local meme…", checkin: "Say something about where you are (optional)", talk: "Start a discussion with your neighbours…", update: "Share an update with everyone here…" };
  // feed v2 (FEED_V2=on, /api/me says feedV2: true): the Updates chip, who may write one, the per-row menu, the one national confirmation
  const feedV2 = () => Boolean(me && me.feedV2);
  const UPDATE_HINT = "Updates come from the city founder, the country manager or Vicinity.";
  const mayUpdate = () => Boolean(me && me.roles && (me.roles.admin || (scope === "city" ? me.roles.founder : me.roles.manager)));
  /** POST /api/posts; the first national post asks once ("Everyone in <country> will see this. Post it?") and is sent again with ack: true. */
  async function postWithAck(body) {
    const r = await api("/api/posts", body);
    if (r.error !== "needs_ack") return r;
    if (!confirm(`Everyone in ${countryName(r.country || (me && me.user.home.country))} will see this. Post it?`)) return { ok: false, error: "not_sent" };
    return api("/api/posts", { ...body, ack: true });
  }
  const NEEDS_WALLET_POST = "Link a wallet and hold any $VICINITY to post.";
  const POST_ERR = {
    holders_only: () => (me && !me.user.wallet ? NEEDS_WALLET_POST : "Only $VICINITY holders can post and vote now that it's live. Holding any amount unlocks it."),
    no_addresses: "Contract addresses can't be posted. The only official one is on the Token page.",
    too_long: (d) => `That's too long (max ${d.max} characters).`,
    empty: "Write something or add a picture.",
    banned: "You've been banned from posting here.",
    checked_in_today: "You already checked in today. Come back tomorrow 🔥",
    not_in_city: (d) => d.here ? `You're in ${d.here} right now, not ${me.user.home.name}.` : `You're not inside ${me.user.home.name} right now.`,
    bad_image: "That picture couldn't be used. Try a JPG or PNG.",
    no_home: "Set your home community first.",
    already_hidden: "It's already hidden.",
    already_proposed: "A ban for this person is already waiting for approval.",
    already_appealed: "You've already appealed this.",
    no_image: "An update is words only: no picture.",
    too_many_mutes: "You've muted as many people as we allow. Unmute someone first.",
    self: "You can't mute yourself.",
    feed_unavailable: "The feed is having trouble right now. Please try again in a few minutes.",
  };
  /** The tabbed dashboard: a member the server would refuse (holders_only: launched, not holding, not an admin) sees one line instead of a form. */
  const postLocked = () => Boolean(v2 && me && me.launched && me.roles && !me.roles.holder && !me.roles.admin);
  function setupComposer() {
    const national = scope === "country", checkin = kind === "checkin", update = kind === "update";
    const locked = postLocked(), lock = $("#feed .composer-lock");
    $$(".chips [data-feed-v2]").forEach((b) => (b.hidden = !feedV2()));
    $("#feed .chips").classList.toggle("chips--4", feedV2()); // four kinds in the tabbed layout's grid (polish-dash.css)
    // the Updates chip: everyone reads the hint; only the founder (Local), the manager (National) or an admin gets the form
    const hint = $("#c-hint"); hint.hidden = !update; hint.textContent = update ? UPDATE_HINT : "";
    lock.hidden = !locked;
    if (locked) {
      const wallet = Boolean(me.user.wallet), go = $("#feed .composer-lock__go");
      $("#feed .composer-lock__text").textContent = wallet ? "Hold any $VICINITY to post and vote." : "Link a wallet and hold any $VICINITY to post.";
      go.textContent = wallet ? "Get $VICINITY" : "Connect wallet";
      go.href = wallet ? "#home" : "/connect?mode=link";
      if (wallet) go.dataset.go = "#trade"; else delete go.dataset.go;
    }
    $("#composer").hidden = (national && checkin) || locked || (update && !mayUpdate());
    $("#c-text").placeholder = me && me.launched && !me.user.wallet ? NEEDS_WALLET_POST : PLACEHOLDER[kind]; // after launch only holders post: a wallet comes first
    $("#c-text").maxLength = kind === "talk" ? 1000 : kind === "meme" ? 280 : update ? 500 : 140;
    $("#c-pic-label").hidden = kind !== "meme";
    $("#c-post").textContent = checkin ? "📍 Check in here" : "Post";
    if (kind !== "meme") clearPicture();
    count();
  }
  const count = () => { const t = $("#c-text"); $("#c-count").textContent = t.value.length ? `${t.value.length}/${t.maxLength}` : ""; };
  $("#c-text").addEventListener("input", count);
  $$(".seg [data-scope]").forEach((b) => b.addEventListener("click", () => {
    scope = b.dataset.scope; $$(".seg [data-scope]").forEach((x) => x.setAttribute("aria-selected", String(x === b))); setupComposer(); loadFeed(true);
  }));
  $$(".chips [data-kind]").forEach((b) => b.addEventListener("click", () => {
    kind = b.dataset.kind; $$(".chips [data-kind]").forEach((x) => x.setAttribute("aria-selected", String(x === b))); setupComposer(); loadFeed(true);
  }));
  $$("[data-sort]").forEach((b) => b.addEventListener("click", () => {
    sort = b.dataset.sort; $$("[data-sort]").forEach((x) => x.setAttribute("aria-pressed", String(x === b))); loadFeed(true);
  }));
  $("#f-more").addEventListener("click", () => loadFeed(false));

  function emptyFeed() {
    const li = el("li", "empty-feed");
    const where = scope === "city" ? me.user.home.name : countryName(me.user.home.country);
    li.append(el("strong", null, `${{ meme: "No memes yet", checkin: "No check-ins yet", talk: "No discussions yet", update: "No updates yet" }[kind]} in ${where}.`),
      el("span", null, kind === "checkin" && scope === "country" ? "Check in from your city's Local tab." : kind === "update" ? UPDATE_HINT : "Be the first: the first posts set the tone for everyone who joins after you."));
    return li;
  }
  async function loadFeed(reset) {
    if (loading) return; loading = true;
    const list = $("#posts");
    if (reset) { oldest = 0; list.replaceChildren(el("li", "muted", "Loading…")); }
    const d = await api(`/api/posts?scope=${scope}&kind=${kind}&sort=${sort}${!reset && oldest ? `&before=${oldest}` : ""}`);
    loading = false;
    if (!d.ok) { list.replaceChildren(el("li", "muted", errText(POST_ERR, d, "Couldn't load posts. Try again."))); return; }
    if (reset) list.replaceChildren();
    if (reset && !d.posts.length) list.append(emptyFeed());
    for (const p of d.posts) list.append(postEl(p));
    if (d.posts.length) oldest = d.posts[d.posts.length - 1].id;
    $("#f-more").hidden = sort === "top" || d.posts.length < 20;
    $("#f-note").textContent = sort === "top" ? `This week's vote · since ${new Date(d.weekStart).toLocaleDateString()}` : scope === "city" ? `Only people from ${me.user.home.name} see this` : `Everyone in ${countryName(me.user.home.country)} sees this`;
  }

  /** A small inline form: pick a reason (+ note), then run `go(reason, note)`. */
  function reasonForm(host, label, go) {
    host.querySelector(".reason-form")?.remove();
    const f = el("form", "reason-form");
    const sel = el("select"); sel.setAttribute("aria-label", "Reason");
    sel.append(...Object.entries(REASONS).map(([v, t]) => Object.assign(el("option", null, t), { value: v })));
    const note = el("input"); note.maxLength = 200; note.placeholder = "Note (public, optional)"; note.setAttribute("aria-label", "Note");
    const ok = el("button", "btn btn--primary btn--sm", label); ok.type = "submit";
    f.append(sel, note, ok, actBtn("Cancel", () => f.remove()));
    f.addEventListener("submit", async (e) => { e.preventDefault(); ok.disabled = true; await go(sel.value, note.value.trim()); ok.disabled = false; f.remove(); });
    host.append(f);
  }
  async function appeal(actionId) {
    const text = prompt("Why was this wrong? (someone who wasn't involved will decide)");
    if (!text) return;
    const r = await api("/api/appeals", { actionId, text });
    toast(r.ok ? "Appeal sent" : errText(POST_ERR, r, "Couldn't send.")); if (r.ok) refresh();
  }

  function postEl(p, { reply = false, queue = false, onDeleted = null } = {}) {
    const li = el("li", `post${p.hidden ? " is-hidden" : ""}`);
    if (!reply) {
      const v = el("div", "post__vote");
      const up = el("button", null, "▲"); up.type = "button"; up.setAttribute("aria-pressed", String(p.voted)); up.setAttribute("aria-label", "Vote");
      if (p.mine || p.hidden) up.disabled = true;
      const score = el("strong", null, fmt(p.score));
      up.addEventListener("click", async () => {
        const r = await api("/api/posts/vote", { id: p.id });
        if (!r.ok) return toast(errText(POST_ERR, r, "Couldn't vote."));
        up.setAttribute("aria-pressed", String(r.voted)); score.textContent = fmt(r.score);
        if (r.voted && r.weight > 1) toast(`Your vote counts ×${r.weight}`);
      });
      v.append(up, score); li.append(v);
    }
    const meta = el("div", "post__meta");
    meta.append(memberLink(p.author.name, p.author.handle));
    if (p.author.manager) meta.append(labelled(el("span", "tag tag--gold"), "shield", "🛡️", "Manager"));
    if (p.author.founder) meta.append(labelled(el("span", "tag tag--gold"), "crown", "👑", p.author.founder));
    if (p.where && scope === "country") meta.append(labelled(el("span", "tag"), "pin", "📍", p.where));
    meta.append(el("span", null, `· ${ago(p.at)}`));
    if (p.hidden) meta.append(el("span", "tag tag--no", p.hiddenUntil ? `Hidden until ${when(p.hiddenUntil)}` : "Hidden"));
    if (p.hideAction) meta.append(el("span", "tag", REASONS[p.hideAction.reason] || p.hideAction.reason));
    if (p.pendingBy) meta.append(el("span", "tag tag--warn", `hidden by ${p.pendingBy}, needs a 2nd moderator`));
    if (p.reports) meta.append(el("span", "tag tag--warn", `${p.reports} report${p.reports === 1 ? "" : "s"}`));
    if (p.deleted) meta.append(el("span", "tag tag--no", "Deleted by the author")); // the moderators' queue keeps it as evidence; it is in no feed
    li.append(meta);
    if (p.body) li.append(p.kind === "checkin" && !reply ? labelled(el("p", "post__body"), "pin", "📍", p.body) : el("p", "post__body", p.body));
    if (p.image) { const img = el("img", "post__img"); img.src = p.image; img.alt = "Meme picture"; img.loading = "lazy"; li.append(img); }
    const actions = el("div", "post__actions");
    if (!reply && !queue && p.kind !== "checkin" && !p.hidden) {
      const rb = labelled(actBtn("", () => toggleReplies(li, p, rb)), "chat", "💬", p.replies ? `${p.replies} repl${p.replies === 1 ? "y" : "ies"}` : "Reply");
      actions.append(rb);
    }
    if (p.mine && p.hidden && p.hideAction) actions.append(actBtn("Appeal", () => appeal(p.hideAction.id)));
    const report = () => actBtn("Report", async () => {
      const reason = prompt("Why are you reporting this? (optional)");
      if (reason === null) return;
      const r = await api("/api/posts/report", { id: p.id, reason });
      toast(r.ok ? "Reported. Thanks for keeping your city clean." : errText(POST_ERR, r, "Couldn't report."));
    });
    if (feedV2()) {
      if (p.author && p.author.handle) li.dataset.author = p.author.handle;
      const items = [];
      if (p.mine && !p.deleted) items.push(actBtn("Delete", async () => {
        if (!confirm("Delete this post? It disappears for everyone.")) return;
        const r = await api("/api/posts/delete", { id: p.id });
        if (!r.ok) return toast(errText(POST_ERR, r, "Couldn't delete."));
        li.remove(); toast("Deleted");
        if (onDeleted) onDeleted(); // a reply: the parent's count goes down
      }));
      else if (!p.mine) {
        // Mute only where there is a profile to unmute from (PROFILES=on, me.profilesFlag)
        if (p.author && p.author.handle && me.profilesFlag) items.push(actBtn("Mute", async () => {
          const r = await api("/api/mute", { user: p.author.handle, on: true });
          if (!r.ok) return toast(errText(POST_ERR, r, "Couldn't mute."));
          $$(`#posts .post[data-author="${CSS.escape(p.author.handle)}"]`).forEach((x) => x.remove());
          toast(`Muted ${p.author.name}. Unmute from their profile.`);
        }));
        if (!p.hidden && !p.deleted) items.push(report());
      }
      if (items.length) {
        const menu = el("div", "post__menu"); menu.hidden = true; menu.append(...items);
        const more = el("button", "post__more", "···"); more.type = "button"; more.setAttribute("aria-label", "More"); more.setAttribute("aria-expanded", "false");
        more.addEventListener("click", () => { menu.hidden = !menu.hidden; more.setAttribute("aria-expanded", String(!menu.hidden)); });
        actions.append(more, menu);
      }
    } else if (!p.mine && !p.hidden) actions.append(report());
    if (p.canModerate && !p.mine) {
      if (p.deleted) { /* nothing to hide or unhide: the author took it down; a ban can still be proposed */ }
      else if (!p.hidden) actions.append(actBtn("Hide", () => reasonForm(li, "Hide for 24 h", async (reason, note) => {
        const r = await sensitive(() => api("/api/mod/hide", { id: p.id, reason, note }));
        toast(r.ok ? (r.confirmed ? "Hidden (confirmed by reports)" : "Hidden for 24 hours unless a second moderator confirms") : errText(POST_ERR, r, "Couldn't hide."));
        if (r.ok) { loadFeed(true); loadMod(); }
      })));
      else {
        if (p.pendingBy === "another moderator") actions.append(actBtn("Confirm hide", () => reasonForm(li, "Confirm", async (reason, note) => {
          const r = await sensitive(() => api("/api/mod/hide", { id: p.id, reason, note }));
          toast(r.ok ? "Confirmed: stays hidden" : errText(POST_ERR, r, "Couldn't confirm.")); if (r.ok) { loadFeed(true); loadMod(); }
        })));
        actions.append(actBtn("Unhide", async () => {
          const r = await sensitive(() => api("/api/mod/unhide", { id: p.id }));
          toast(r.ok ? "Visible again" : errText(POST_ERR, r, "Couldn't unhide.")); if (r.ok) { loadFeed(true); loadMod(); }
        }));
      }
      if (me.level === "manager" || me.level === "admin") actions.append(actBtn("Propose ban", () => reasonForm(li, "Propose a 30-day ban", async (reason, note) => {
        const r = await sensitive(() => api("/api/mod/ban", { postId: p.id, reason, note }));
        toast(r.ok ? "Ban proposed: another moderator must approve it" : errText(POST_ERR, r, "Couldn't propose.")); if (r.ok) loadMod();
      })));
    }
    if (actions.children.length) li.append(actions);
    return li;
  }
  async function toggleReplies(li, p, btn) {
    const open = li.querySelector(".post__replies");
    if (open) { open.remove(); li.querySelector(".reply-form")?.remove(); return; }
    const ul = el("ul", "post__replies"); ul.append(el("li", "muted", "Loading…"));
    const form = el("form", "reply-form");
    const input = el("input"); input.maxLength = 500; input.placeholder = "Write a reply…"; input.setAttribute("aria-label", "Reply");
    const send = el("button", "btn btn--primary btn--sm", "Reply"); send.type = "submit";
    form.append(input, send);
    li.append(ul, form);
    const d = await api(`/api/posts?parent=${p.id}`);
    const relabel = () => labelled(btn, "chat", "💬", p.replies ? `${p.replies} repl${p.replies === 1 ? "y" : "ies"}` : "Reply");
    const onDeleted = () => { p.replies = Math.max(0, p.replies - 1); relabel(); }; // your own reply, deleted: the count follows at once
    ul.replaceChildren(...(d.posts || []).map((r) => postEl(r, { reply: true, onDeleted })));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = input.value.trim(); if (!text) return;
      send.disabled = true;
      const r = await postWithAck({ parent: p.id, body: text });
      send.disabled = false;
      if (r.error === "not_sent") return; // the person said no to the national confirmation
      if (!r.ok) return toast(errText(POST_ERR, r, "Couldn't reply."));
      input.value = ""; ul.append(postEl(r.post, { reply: true, onDeleted }));
      p.replies += 1; relabel();
    });
  }

  // pictures: shrunk in the browser (max 900 px, under 190 KB) before they're sent
  function clearPicture() { picture = null; $("#c-preview").hidden = true; $("#c-pic").value = ""; }
  $("#c-pic").addEventListener("change", async () => {
    const file = $("#c-pic").files[0]; if (!file) return;
    try {
      const url = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
      let max = 900, quality = 0.82, out = "";
      for (let i = 0; i < 6; i++) {
        const k = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement("canvas"); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        out = c.toDataURL("image/webp", quality);
        if (!out.startsWith("data:image/webp")) out = c.toDataURL("image/jpeg", quality);
        if (out.length * 0.75 < 190_000) break;
        max = Math.round(max * 0.8); quality -= 0.08;
      }
      picture = out.slice(out.indexOf(",") + 1);
      $("#c-preview").src = out; $("#c-preview").hidden = false;
    } catch { toast("That picture couldn't be read."); clearPicture(); }
  });

  $("#composer").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("#c-post"); showErr("#c-err", "");
    const body = { scope, kind, body: $("#c-text").value.trim() };
    if (picture) body.image = picture;
    btn.disabled = true;
    try {
      if (kind === "checkin") { btn.textContent = "Checking your location…"; body.attestation = (await locateFor("checkin")).attestation; }
      const r = await postWithAck(body);
      if (r.error === "not_sent") return; // the person said no to the national confirmation
      if (!r.ok) throw new Error(kind === "update" && r.error === "not_allowed" ? UPDATE_HINT : errText(POST_ERR, r, "Couldn't post. Please try again."));
      $("#c-text").value = ""; clearPicture(); count();
      if (sort !== "new") $("[data-sort='new']").click();
      else { const list = $("#posts"); list.querySelector(".empty-feed")?.remove(); list.prepend(postEl(r.post)); }
      toast(kind === "checkin" ? `📍 Checked in to ${me.user.home.name}` : "Posted ✓");
      if (kind === "checkin") { const rr = btn.getBoundingClientRect(); burst(rr.left + rr.width / 2, rr.top); refresh(); }
    } catch (x) { showErr("#c-err", x.message); }
    finally { btn.disabled = false; setupComposer(); }
  });

  /* ---------- your city's coin: the City Founder designs it (name, pitch, colour, logo, pair) ---------- */
  const SOL_MINT = "So11111111111111111111111111111111111111112";
  const COIN_ERR = {
    not_founder: "Only the city's active founder can design its coin.",
    coin_locked: "This coin has launched, so its design is locked.",
    coin_approved: "The owner has approved this coin on the blockchain, so its design is fixed now: what was approved is what launches. To change it, ask the owner to withdraw the approval first.",
    coin_being_approved: "The owner is approving this coin right now, so its design is fixed for a few minutes. Try again in 5 minutes.",
    bad_name: "Use 2 to 32 letters, numbers or spaces for the name (no links).",
    too_long: (d) => `That's too long (at most ${d.max} characters).`,
    no_addresses: "Contract addresses can't go in a coin's name or pitch.",
    no_links: "Links can't go in the pitch.",
    bad_pair: "Pick SOL, USDC or RAY.",
    bad_color: "Pick one of the colours.",
    bad_image: "That picture couldn't be used. Try a PNG, JPEG or WebP.",
    bad_address: "That isn't a Solana contract address.",
    no_ticker: "This city has no ticker yet. Tell us and we will add it.",
    list_unavailable: "The city list could not be read just now. Try again in a minute.",
    not_a_city_coin: "That's $VICINITY or the pair, not your city's coin.",
    design_first: "Save a design first.",
    mint_taken: "That contract is already another city's coin.",
    needs_second_person: "Someone other than the founder has to check a coin's contract.",
    mint_required: "The decision has to name the contract address it is about. Reload the queue and try again.",
    mint_changed: "The founder submitted a different address since you opened this one. Reload the queue and check the new one.",
    not_a_mint: "The blockchain says that address is not a token with a supply. Nothing was recorded.",
    chain_unavailable: "The blockchain could not be asked just now. Nothing was recorded; try again in a minute.",
  };
  let coinData = null, coinPairs = null, vicMint = null, logoData = null, dropLogo = false, studioDirty = false;
  const v2Coin = () => { if (v2) v2.coin({ coin: coinData, vicMint }); };
  // the city coin's label ("$UTICA", or the city's name while it has no ticker) and the short text on its disc
  const cityTk = () => coinLabel(me && me.community);
  const cityDisc = () => coinDisc(me && me.community) || "CITY";
  const picked = (name, fallback) => (document.querySelector(`input[name='${name}']:checked`) || {}).value || fallback;
  const num = (x) => new Intl.NumberFormat(undefined, { maximumSignificantDigits: 6 }).format(x);
  const usd = (x) => new Intl.NumberFormat(undefined, { maximumFractionDigits: x < 1 ? 4 : 2 }).format(x);

  async function loadCoin() {
    const c = me && me.community; if (!c) return;
    const r = await api(`/api/coins?city=${encodeURIComponent(c.id)}`);
    if (!r || r.ok === false) return;
    coinData = r.coin || null; coinPairs = r.pairs || coinPairs; vicMint = r.vicinity || null;
    renderCoin(); renderTrade(); v2Coin(); lpMount();
    if (me.roles && me.roles.admin) loadCoinQueue();
  }
  function paintCoin({ name, color, logo, pair }) {
    const face = $("#coin-art-face"), img = $("#coin-logo");
    // a picture whose URL answers "not found" (src/logos.js: its bytes no longer match what was approved) gives way to the initials
    if (!img.dataset.fallback) { img.dataset.fallback = "1"; img.addEventListener("error", () => { if (!img.hidden) { img.hidden = true; face.hidden = false; } }); }
    $("#coin-art").dataset.color = color || "gold";
    for (const disc of [$(".pass__coin"), $("#welcome-disc").parentNode, $("#cc-face").parentNode]) disc.dataset.color = color || "gold"; // one coin, one colour
    if (logo) { img.src = logo; img.hidden = false; } else { img.hidden = true; img.removeAttribute("src"); }
    discText(face, cityDisc()); face.hidden = Boolean(logo);
    $("#coin-name").textContent = name;
    $("#coin-ticker").textContent = cityTk();
    $("#coin-pair").textContent = pair || "chosen by the founder";
  }
  function renderCoin() {
    const c = me.community, tk = cityTk(), cd = coinData, seat = c.seat;
    // the server lets a Seed Steward design the coin too (src/roles.js); the tabbed dashboard shows them the studio
    const mine = Boolean(seat && seat.you && (seat.status === "active" || (v2 && seat.status === "steward")));
    $("#coin-city").textContent = c.name;
    $$("[data-city-ticker]").forEach((e) => (e.textContent = c.ticker ? tk : `${c.name} coin`));
    const st = $("#coin-status");
    st.className = "tag " + (cd && cd.launched ? "tag--ok" : cd && cd.waiting ? "tag--warn" : cd ? "tag--gold" : "");
    st.textContent = cd && cd.launched ? "● Live" : cd && cd.waiting ? "Contract being checked" : cd ? "Designed" : "Not designed yet";
    // the founder sees their working picture (the server sends logoDraft to them and the staff only); everyone else the approved one or none
    if (!(mine && studioDirty)) paintCoin(cd ? { ...cd, logo: mine ? cd.logoDraft || cd.logo : cd.logo } : { name: c.name, color: "gold", logo: null, pair: null });
    $("#coin-pitch").textContent = cd ? cd.pitch : "";
    $("#coin-by").textContent = cd ? `Designed by ${cd.by || "the City Founder"} · updated ${date(cd.updatedAt)}` : "";
    logoState(mine ? cd : null);
    $("#coin-contract").hidden = !(cd && cd.mint);
    // a short chip (the whole address is the copy button's name and the chip's title); Copy copies the whole address
    if (cd && cd.mint) { $("#coin-mint").textContent = cd.mint; $("#coin-mint").title = cd.mint; $("#coin-mint-copy").setAttribute("aria-label", `Copy the contract address ${cd.mint}`); }
    tickerLine();
    $("#coin-note").textContent = mine
      ? (cd ? (cd.launched ? `${c.name}'s coin is live. Its design is locked, as the rules promise.` : "Change anything until your coin launches. Every save is public in the log.")
        : `Your coin, your call. Design ${c.name}'s coin below: everyone in ${c.name} will see it.`)
      : cd ? (cd.launched ? `The one official ${c.ticker ? tk : `${c.name} coin`}. Buy or swap it in the panel on the right.` : `Designed by ${c.name}'s founder. It launches on ${lpOn ? "the Vicinity launchpad" : "Raydium LaunchLab"}.`)
      : seat ? `${seat.name}, ${c.name}'s founder, hasn't designed the coin yet. It'll appear here the moment they do.`
      : `${c.name}'s founder designs this coin: its name, logo, colour and what it's paired with. The seat is still open: see the founder path.`;
    $("#coin-studio").hidden = !mine || Boolean(cd && cd.launched);
    if (mine && !studioDirty) fillStudio();
  }
  const countPitch = () => ($("#cs-count").textContent = `${$("#cs-pitch").value.length}/200`);
  // the founder's one line about their picture's check (src/logos.js): nobody else gets these fields, so nobody else sees a line.
  // The reasons in the same words the admin picks from (public/admin.js PICTURE_REASONS). "Shows its initials on the site": a coin
  // without an approved picture is drawn as the city's initials on its colour here, on the launchpad and on the coin page; the
  // Vicinity badge is what /coin-meta/<mint>.png serves to wallets.
  const REASON_WORDS = { scam: "scam or impersonation", abuse: "abuse or hate", illegal: "illegal", spam: "spam", off_topic: "not about the city", other: "breaks the rules" };
  function logoState(cd) {
    const p = $("#coin-logo-state");
    if (!p) return;
    const s = cd && cd.logoStatus;
    let text = "";
    if (s === "pending") {
      text = cd.logo ? "Your new picture is being checked. Until it is approved, your coin keeps showing the picture approved before."
        : "Your picture is being checked. Until it is approved, nobody else sees it: your coin shows its initials on the site and the Vicinity badge in wallets.";
      if (!cd.launched) text += " Your coin can still be approved and launched meanwhile.";
    } else if (s === "rejected") {
      text = `Not approved: ${REASON_WORDS[cd.logoReason] || cd.logoReason || "breaks the rules"}.${cd.logoNote ? ` ${cd.logoNote}${/[.!?]$/.test(cd.logoNote) ? "" : "."}` : ""} Replace it to try again.`;
      if (cd.logo) text += " Your coin keeps showing the picture approved before.";
    } else if (s === "approved") text = "Approved.";
    p.textContent = text; p.hidden = !text;
    p.className = `tiny coin-logo-state${s ? ` is-${s}` : ""}`;
  }
  function fillStudio() {
    const cd = coinData;
    $("#cs-name").value = cd ? cd.name : me.community.name;
    // the ticker field shows the server's ticker and where it comes from (the chain's once launched, else the list's); a city without
    // one shows its name and no claim about the map
    $("#cs-ticker").value = cityTk();
    const tl = $("#cs-ticker-label"); if (tl) tl.textContent = me.community.tickerSource === "chain" ? "Ticker · on chain" : me.community.ticker ? "Ticker · fixed by the map" : "Ticker · none yet";
    $("#cs-pitch").value = cd ? cd.pitch : "";
    const p = document.querySelector(`input[name='cs-pair'][value='${cd ? cd.pair : "SOL"}']`); if (p) p.checked = true;
    const k = document.querySelector(`input[name='cs-color'][value='${cd ? cd.color : "gold"}']`); if (k) k.checked = true;
    logoData = null; dropLogo = false;
    $("#cs-logo-remove").hidden = !(cd && (cd.logoDraft || cd.logo));
    countPitch();
  }
  function studioPreview() {
    studioDirty = true;
    paintCoin({ name: $("#cs-name").value.trim() || me.community.name, color: picked("cs-color", "gold"), pair: picked("cs-pair", "SOL"),
      logo: logoData ? `data:${logoData.type};base64,${logoData.b64}` : dropLogo ? null : coinData && (coinData.logoDraft || coinData.logo) });
    countPitch();
  }
  $("#coin-studio").addEventListener("input", studioPreview);
  $("#coin-studio").addEventListener("change", (e) => { if (e.target.id !== "cs-logo") studioPreview(); });
  // the logo: cropped to a centred square and shrunk in the browser (under 190 KB) before it's sent
  $("#cs-logo").addEventListener("change", async () => {
    const file = $("#cs-logo").files[0]; if (!file) return;
    try {
      const url = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
      const side = Math.min(img.width, img.height);
      let size = 512, out = "";
      for (let i = 0; i < 5; i++) {
        const cv = document.createElement("canvas"); cv.width = cv.height = size;
        cv.getContext("2d").drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
        out = cv.toDataURL("image/webp", 0.86);
        if (!out.startsWith("data:image/webp")) out = cv.toDataURL("image/png");
        if (out.length * 0.75 < 190_000) break;
        size = Math.round(size * 0.8);
      }
      logoData = { type: out.slice(5, out.indexOf(";")), b64: out.slice(out.indexOf(",") + 1) };
      dropLogo = false; $("#cs-logo-remove").hidden = false; studioPreview();
    } catch { toast("That picture couldn't be read."); }
    $("#cs-logo").value = "";
  });
  $("#cs-logo-remove").addEventListener("click", () => { logoData = null; dropLogo = true; $("#cs-logo-remove").hidden = true; studioPreview(); });
  $("#coin-studio").addEventListener("submit", async (e) => {
    e.preventDefault(); showErr("#cs-err", "");
    const btn = $("#cs-save"); btn.disabled = true;
    const body = { name: $("#cs-name").value.trim(), pitch: $("#cs-pitch").value.trim(), pair: picked("cs-pair", "SOL"), color: picked("cs-color", "gold") };
    if (logoData) body.image = logoData.b64; else if (dropLogo) body.removeLogo = true;
    try {
      const r = await sensitive(() => api("/api/coins/design", body));
      if (!r.ok) throw new Error(errText(COIN_ERR, r, "Couldn't save the design. Please try again."));
      coinData = r.coin; studioDirty = false; renderCoin(); renderTrade(); v2Coin();
      toast(`🎨 ${me.community.name}'s coin is saved`);
      const rr = btn.getBoundingClientRect(); burst(rr.left + rr.width / 2, rr.top);
    } catch (x) { showErr("#cs-err", x.message); }
    finally { btn.disabled = false; }
  });
  $("#cs-mint-send").addEventListener("click", async () => {
    showErr("#cs-err", "");
    const r = await sensitive(() => api("/api/coins/mint", { mint: $("#cs-mint").value.trim() }));
    if (!r.ok) { showErr("#cs-err", errText(COIN_ERR, r, "Couldn't send it. Please try again.")); return; }
    coinData = r.coin; $("#cs-mint").value = ""; renderCoin(); v2Coin();
    toast("Sent. An admin checks it on the blockchain.");
  });
  $("#coin-mint-copy").addEventListener("click", () => coinData && coinData.mint && copy(coinData.mint, "Contract copied"));

  /* ---------- the launch on our own launchpad (public/lp-launch.js): only while its settings are on (the probe answers); then the
     Raydium LaunchLab copy and the "add the contract" field go away, and the city's founder gets the launch card (it reads the chain
     once per visit and city; the card refreshes itself after a launch or a fee collection) ---------- */
  function lpCopy() {
    $$("[data-launchlab-copy]").forEach((e) => (e.hidden = lpOn));
    $$("[data-lp-only]").forEach((e) => (e.hidden = !lpOn));
  }
  async function lpMount() {
    const L = window.LPLaunch;
    if (!L || typeof L.probe !== "function") return;
    if (!lpProbed) { lpProbed = true; lpOn = Boolean(await L.probe()); if (lpOn) { lpCopy(); renderCoin(); } }
    if (!lpOn) return;
    const c = me && me.community, seat = c && c.seat, card = $("#lp-launch");
    const mine = Boolean(seat && seat.you && (seat.status === "active" || seat.status === "steward"));
    if (!mine) { card.hidden = true; lpCity = null; if (v2) v2.lp({ on: true, state: null }); return; }
    if (lpCity === c.id) return;
    lpCity = c.id;
    const r = await L.founder(card, { cityId: c.id, design: coinData, onChange: (x) => { if (v2) v2.lp(x); loadCoin(); } }); // launched: the coin card follows
    if (coinData && coinData.launched && r.state !== "launched") card.hidden = true; // launched on Raydium LaunchLab before: nothing to launch here
    if (v2) v2.lp(r);
  }

  // admins: contracts founders sent, waiting for someone else to check them
  async function loadCoinQueue() {
    const r = await api("/api/coins?waiting=1");
    const list = r && r.ok ? r.waiting : [];
    $("#coin-admin").hidden = !list.length;
    if (v2) v2.coinQueue(list.length);
    window.VRole.queue({ coins: list.length });
    $("#coin-waiting").replaceChildren(...list.map((w) => {
      const li = el("li", "coin-check");
      const link = el("a", "mono coin-check__mint", w.pendingMint); // in full: a look-alike address can match the first and last few characters link.href = `https://solscan.io/token/${w.pendingMint}`; link.target = "_blank"; link.rel = "noopener";
      link.title = w.pendingMint; link.setAttribute("aria-label", `${w.pendingMint} on Solscan`);
      const cp = actBtn("Copy", () => copy(w.pendingMint, "Contract address copied"), "link-btn link-btn--tiny coin-check__copy"); cp.setAttribute("aria-label", `Copy the contract address ${w.pendingMint}`);
      const head = el("p", "coin-check__head"); head.append(el("strong", null, w.cityName), el("span", "tiny muted", ` · ${w.pair} pair · sent ${ago(w.pendingAt)}`));
      const mintRow = el("p", "coin-check__row"); mintRow.append(link, " ", cp);
      li.append(head, mintRow);
      // the decision carries the address the admin looked at: the server records only if it is still the one waiting
      const decide = (approve, note) => sensitive(() => api("/api/coins/mint/decide", { city: w.city, mint: w.pendingMint, approve, note }));
      const acts = el("div", "coin-check__actions");
      acts.append(
        actBtn("Record it", async () => { const x = await decide(true, "Checked on the blockchain"); toast(x.ok ? "Recorded: it's the official coin now ✓" : errText(COIN_ERR, x, "Couldn't do that.")); loadCoinQueue(); }, "btn btn--primary btn--sm"),
        actBtn("Reject", () => reasonForm(li, "Reject", async (reason, note) => {
          const x = await decide(false, note || REASONS[reason]); toast(x.ok ? "Rejected" : errText(COIN_ERR, x, "Couldn't do that.")); loadCoinQueue();
        }), "btn btn--glass btn--sm"));
      li.append(acts);
      return li;
    }));
  }

  /* ---------- buy & swap: straight to Jupiter or Raydium, where you sign in your own wallet ---------- */
  let route = "vic", flipped = false, priceCache = { key: "", at: 0, p: {} }, estTimer = 0;
  function routeInfo() {
    const cd = coinData, tk = cityTk(), cityMint = cd && cd.mint ? cd.mint : null;
    const base = route === "vic" ? [["SOL", SOL_MINT], ["$VICINITY", vicMint]]
      : route === "city" ? [[cd ? cd.pair : "SOL", cd ? cd.pairMint : SOL_MINT], [tk, cityMint]]
      : [[tk, cityMint], ["$VICINITY", vicMint]];
    const [a, b] = flipped ? [base[1], base[0]] : base;
    const missing = route !== "city" && !vicMint ? "$VICINITY" : route !== "vic" && !cityMint ? tk : null;
    return { a, b, missing, tk };
  }
  const swapSide = (m) => (m === SOL_MINT ? "SOL" : m);
  /**
   * With the in-app swap on (SWAP=on, /api/official.swap): the Buy & swap card holds the swap panel (public/swap.js) instead of
   * links to jup.ag / raydium.io. One panel per route; a route whose coin is not live yet keeps the old copy. True when the
   * panel took the card over (the rest of renderTrade is skipped).
   */
  let swapOn = null;
  if (window.V.official) window.V.official.then((o) => { swapOn = Boolean(o && o.swap === true); if (swapOn) renderTrade(); });
  const tradeAway = () => Boolean(v2 && me && me.user && me.signupFlow === "v2" && (!me.user.wallet || phoneBrowser()));
  function mountSwap(a, b, missing) {
    if (!swapOn || !window.VSwap || tradeAway()) return false;
    const box = $("#trade .swapbox"); if (!box) return false;
    let slot = $("#tr-swap");
    if (!slot) { slot = el("div"); slot.id = "tr-swap"; box.after(slot); }
    const live = !missing && a[1] && b[1];
    box.hidden = Boolean(live); slot.hidden = !live;
    for (const id of ["#tr-go", "#tr-go-2", "#tr-note"]) $(id).classList.toggle("is-gone", Boolean(live));
    $("#trade").classList.toggle("has-panel", Boolean(live)); // the panel brings its own heading: the card's kicker, title and tag step back (polish-dash.css)
    if (!live) return false;
    const key = `${route}|${a[1]}|${b[1]}`;
    if (slot.dataset.key !== key) {
      slot.dataset.key = key; slot.replaceChildren(); slot.removeAttribute("data-swap-mounted");
      window.VSwap.mount(slot, { mode: route === "swap" ? "swap" : "buy", in: a[1], out: b[1], title: route === "swap" ? `Swap ${a[0]} and ${b[0]}` : `Buy ${b[0]}` });
    }
    $("#trade-state").className = "tag tag--ok"; $("#trade-state").textContent = "● Live";
    return true;
  }
  function renderTrade() {
    if (!me || !me.community) return;
    const { a, b, missing, tk } = routeInfo();
    $$("[data-city-tk]").forEach((e) => (e.textContent = tk));
    $$("#trade [data-route]").forEach((x) => x.setAttribute("aria-selected", String(x.dataset.route === route)));
    if (mountSwap(a, b, missing)) return;
    $("#tr-in").lastElementChild.textContent = a[0];
    $("#tr-outk").lastElementChild.textContent = b[0];
    $("#tr-in").dataset.token = a[0].startsWith("$") ? (a[0] === "$VICINITY" ? "vic" : "city") : a[0].toLowerCase();
    $("#tr-outk").dataset.token = b[0].startsWith("$") ? (b[0] === "$VICINITY" ? "vic" : "city") : b[0].toLowerCase();
    const state = $("#trade-state"), go = $("#tr-go"), go2 = $("#tr-go-2"), amt = $("#tr-amt");
    // "● Live" only once /api/prices answered with both prices (see estimate): a recorded contract alone is listed, not live
    state.className = "tag tag--warn";
    state.textContent = missing ? (!vicMint ? "Opens at launch" : `${tk} isn't live yet`) : "Listed · no price yet";
    amt.disabled = Boolean(missing);
    if (missing) {
      const mine = me.community.seat && me.community.seat.you;
      go.textContent = !vicMint ? "How to get ready →" : mine ? "Design & launch your coin ↓" : `See ${tk}'s design ↓`;
      go.href = !vicMint ? "/token#buy" : "#coin"; go.removeAttribute("target");
      go2.hidden = true;
      $("#tr-note").textContent = !vicMint
        ? "Trading opens the moment $VICINITY launches on Raydium LaunchLab. Its contract is published on the Token page first."
        : `${tk} trades once ${me.community.name}'s founder launches it and an admin records its contract.`;
    } else {
      go.textContent = `${route === "swap" ? "Swap" : flipped ? `Sell ${a[0]}` : `Buy ${b[0]}`} on Jupiter ↗`;
      go.href = `https://jup.ag/swap/${swapSide(a[1])}-${swapSide(b[1])}`; go.target = "_blank"; go.rel = "noopener";
      // The Raydium button only where a Raydium page exists: the LaunchLab page of $VICINITY or of the city coin. No direct
      // pool between a city coin and $VICINITY is known, so the swap route offers Jupiter alone (it routes through SOL).
      go2.hidden = route === "swap";
      if (!go2.hidden) { go2.href = `https://raydium.io/launchpad/token/?mint=${route === "vic" ? vicMint : coinData.mint}`; go2.textContent = "or on Raydium LaunchLab ↗"; }
      $("#tr-note").textContent = "You sign every swap in your own wallet on Jupiter or Raydium; Vicinity never touches your funds. Price ratio, not a quote. Slippage and fees are set in your wallet.";
    }
    estimate();
  }
  async function estimate() {
    const { a, b, missing } = routeInfo();
    const amount = Number(String($("#tr-amt").value).replace(",", "."));
    $("#tr-out").textContent = "—"; $("#tr-in-usd").textContent = ""; $("#tr-rate").textContent = "";
    if (missing) return;
    const key = `${a[1]},${b[1]}`;
    if (priceCache.key !== key || Date.now() - priceCache.at > 30_000) {
      const r = await api(`/api/prices?mints=${key}`);
      priceCache = { key, at: Date.now(), p: (r && r.prices) || {} };
    }
    const pa = priceCache.p[a[1]], pb = priceCache.p[b[1]], state = $("#trade-state");
    if (!pa || !pb) { $("#tr-rate").textContent = "No live price yet: the swap page shows the exact amount."; state.className = "tag tag--warn"; state.textContent = "Listed · no price yet"; return; }
    state.className = "tag tag--ok"; state.textContent = "● Live";
    $("#tr-rate").textContent = `1 ${a[0]} ≈ ${num(pa / pb)} ${b[0]}`;
    if (amount > 0) { $("#tr-out").textContent = num((amount * pa) / pb); $("#tr-in-usd").textContent = `≈ $${usd(amount * pa)}`; }
  }
  $("#tr-amt").addEventListener("input", () => { clearTimeout(estTimer); estTimer = setTimeout(estimate, 250); });
  $("#tr-flip").addEventListener("click", () => { flipped = !flipped; renderTrade(); });
  $$("#trade [data-route]").forEach((x) => x.addEventListener("click", () => { route = x.dataset.route; flipped = false; renderTrade(); }));

  /* ---------- moderator tools ---------- */
  async function loadMod() {
    const d = await api("/api/mod");
    if (!d.ok || !d.moderator) { $("#mod").hidden = true; if (v2) v2.mod(d); return; }
    $("#mod").hidden = false;
    window.VRole.queue({ posts: d.posts.length, proposals: d.proposals.filter((x) => x.canApprove).length, appeals: d.appeals.length, objections: d.objections.length, towns: d.towns.length, bios: d.bios ? d.bios.length : 0 });
    $("#mod-scope").textContent = `${LEVEL[d.role] || d.role} · ${d.scope}`;
    const sections = [];
    let waiting = 0;
    // the tabbed dashboard folds each queue (open when something waits, its count in the summary); the flag-off page keeps its headings
    const fold = (title, list, n) => {
      waiting += n;
      if (!v2) { const s = el("div", "mod-section"); s.append(el("h3", null, title), list); return s; }
      const s = el("details", "fold mod-section"); s.open = n > 0;
      const sum = el("summary"); sum.append(el("span", "fold__label", title), " ", el("span", "fold__meta", n ? `${n} waiting` : "None"));
      s.append(sum, list); return s;
    };
    const section = (title, items) => { const ul = el("ul", "req-list"); ul.append(...items); return fold(title, ul, items.filter((x) => !x.classList.contains("muted")).length); };
    const empty = (t) => el("li", "muted small", t);
    const decide = (label, fn, cls) => actBtn(label, async () => { const r = await sensitive(fn); toast(r.ok ? "Done ✓" : errText(POST_ERR, r, "Couldn't do that.")); loadMod(); refresh(); if (r.ok) loadFeed(true); }, cls);
    const posts = el("ul", "posts posts--compact");
    posts.append(...(d.posts.length ? d.posts.map((p) => postEl(p, { reply: true, queue: true })) : [empty("No reports. All clean.")]));
    sections.push(fold("Reported and hidden posts", posts, d.posts.length));
    sections.push(section("Ban proposals", d.proposals.length ? d.proposals.map((x) => {
      const li = el("li");
      li.append(el("strong", null, x.target), el("span", "muted", `${REASONS[x.reason] || x.reason}${x.note ? ` · “${x.note}”` : ""} · proposed by ${x.by} · expires ${when(x.expiresAt)}`));
      const acts = el("span", "req-actions");
      if (x.canApprove) acts.append(decide("Approve", () => api("/api/mod/ban/approve", { actionId: x.id }), "btn btn--primary btn--sm"), decide("Reject", () => api("/api/mod/ban/reject", { actionId: x.id }), "btn btn--glass btn--sm"));
      else acts.append(el("span", "tiny muted", "needs someone else"));
      li.append(acts); return li;
    }) : [empty("None waiting.")]));
    sections.push(section("Appeals", d.appeals.length ? d.appeals.map((x) => {
      const li = el("li");
      li.append(el("strong", null, `${x.by}: ${x.action}`), el("span", "muted", `“${x.text}”`));
      const acts = el("span", "req-actions");
      acts.append(decide("Overturn", () => api("/api/appeals/decide", { id: x.id, overturn: true }), "btn btn--primary btn--sm"), decide("Uphold", () => api("/api/appeals/decide", { id: x.id, overturn: false }), "btn btn--glass btn--sm"));
      li.append(acts); return li;
    }) : [empty("None for you to decide.")]));
    if (d.role === "admin") sections.push(section("Objections to founders", d.objections.length ? d.objections.map((x) => {
      const li = el("li");
      li.append(el("strong", null, `${x.founder} · ${x.city} (${x.seatStatus})`), el("span", "muted", `“${x.reason}” · ${ago(x.at)}`));
      const acts = el("span", "req-actions");
      acts.append(decide("Uphold (revoke)", () => api("/api/seats/objections/decide", { id: x.id, uphold: true, note: prompt("Note (public):") || "" }), "btn btn--primary btn--sm"),
        decide("Dismiss", () => api("/api/seats/objections/decide", { id: x.id, uphold: false }), "btn btn--glass btn--sm"));
      li.append(acts); return li;
    }) : [empty("None waiting.")]));
    if (d.role === "admin" || d.role === "manager") sections.push(section('"Add my town" requests', d.towns.length ? d.towns.map((x) => {
      const li = el("li");
      li.append(el("strong", null, `${x.name} (${x.country})`), el("span", "muted", `${x.near || ""} · by ${x.by || "member"} · ${x.status.replace("_", " ")}`));
      const acts = el("span", "req-actions");
      const choice = d.role === "admin" ? [["Approve", "approve", "btn btn--primary btn--sm"], ["Decline", "decline", "btn btn--glass btn--sm"]] : [["Recommend", "recommend", "btn btn--primary btn--sm"], ["Don't recommend", "not_recommend", "btn btn--glass btn--sm"]];
      for (const [label, decision, cls] of choice) acts.append(decide(label, () => api("/api/towns/decide", { id: x.id, decision }), cls));
      li.append(acts); return li;
    }) : [empty("No requests waiting.")]));
    // reported bios: the server sends `bios` only while member profiles are on; clearing one needs a reason and a fresh wallet proof, like a hide
    if (d.bios) sections.push(section("Reported bios", d.bios.length ? d.bios.map((x) => {
      const li = el("li");
      const who = el("strong"); who.append(memberLink(x.handle, x.handle, "a"));
      li.append(who, el("span", "muted", `“${x.bio}” · ${x.reports} report${x.reports === 1 ? "" : "s"} · last ${ago(x.lastAt)}`));
      const acts = el("span", "req-actions");
      acts.append(actBtn("Clear bio", () => reasonForm(li, "Clear the bio", async (reason, note) => {
        const r = await sensitive(() => api("/api/mod/bio/clear", { handle: x.handle, reason, note }));
        toast(r.ok ? "Bio cleared. The member can write a new one." : errText(BIO_MOD_ERR, r, "Couldn't clear it."));
        if (r.ok) loadMod();
      }), "btn btn--glass btn--sm"));
      li.append(acts); return li;
    }) : [empty("No reported bios.")]));
    if (v2 && !waiting) sections.unshift(el("p", "mod-clear", "All clear. Nothing is waiting for you."));
    $("#mod-sections").replaceChildren(...sections);
    if (v2) v2.mod(d);
  }
  const BIO_MOD_ERR = { no_bio: "That bio is already gone.", own_profile: "You can't clear your own bio here: edit it in your profile.", not_enabled: "Member profiles are switched off right now.",
    profiles_unavailable: "Member profiles are having trouble right now. Please try again in a few minutes." };

  /* ---------- "add my town" ---------- */
  async function loadTowns() {
    const d = await api("/api/towns");
    if (!d.ok) return;
    $("#req-mine").replaceChildren(...d.requests.map((r) => {
      const li = el("li");
      const cls = r.status === "approved" ? "tag--ok" : r.status === "declined" ? "tag--no" : "tag--warn";
      li.append(el("strong", null, r.name), el("span", `tag ${cls}`, r.status.replace("_", " ")));
      if (r.note) li.append(el("span", "muted small", `“${r.note}”`));
      return li;
    }));
  }
  $("#req-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("#req-name").value.trim().replace(/\s+/g, " ");
    showErr("#req-err", "");
    if (!/^[\p{L}\p{M}][\p{L}\p{M} .'’-]{0,58}[\p{L}\p{M}.]$/u.test(name)) return showErr("#req-err", "Use letters only for the town name (spaces, - . ' are fine).");
    try {
      const d = await api("/api/towns", { name, attestation: (await locateFor("request")).attestation });
      if (!d.ok) throw new Error(errText({ one_at_a_time: "You already have a request waiting. One at a time.", bad_name: "Please check the town name." }, d, "Couldn't send. Please try again."));
      toast(`Request sent: ${name}.`);
      $("#req-name").value = ""; loadTowns();
    } catch (x) { showErr("#req-err", x.message); }
  });

  /* ---------- live refresh ---------- */
  async function refresh() {
    const d = await api("/api/me");
    if (d.signedIn && d.user.home) render(d);
  }
  setInterval(() => {
    if (!checkedAt) return;
    const s = Math.round((Date.now() - checkedAt) / 1000);
    $("#me-checked").textContent = s < 5 ? "Live" : `Live · ${s < 60 ? s + "s" : Math.round(s / 60) + "m"} ago`;
  }, 5000);
  $("#me-copy").addEventListener("click", () => me && copy(me.user.wallet, "Wallet address copied"));

  /* ---------- profile & settings ---------- */
  const USERNAME_ERR = {
    bad_username: "Usernames are 3–20 characters: letters, numbers and underscores, starting with a letter.",
    username_taken: "That username is taken. Try another one.",
    username_reserved: "That name is reserved. Try another one.",
    username_similar: "That is too close to an existing username. Try another one.",
    slow_down: "You can change your username 3 times a day. Try again tomorrow.",
    reprove: "Please confirm it's you with your wallet first, then try again.",
    sign_in: "Your session ended. Please sign in again.",
    link_new: (d) => COMMON_ERR.link_new(d),
  };
  function openProfile() {
    if (!me) return;
    const u = me.user, name = u.handle || u.name || mask(u.wallet);
    $("#profile-avatar").textContent = initials(name);
    $("#profile-since").textContent = `Member since ${date(u.joined)} · ${LEVEL[me.level] || "Member"}`;
    const linked = Boolean(u.wallet);
    $("#profile-wallet").textContent = linked ? mask(u.wallet) : "No wallet linked";
    $("#profile-wallet").classList.toggle("mono", linked);
    $("#profile-copy").hidden = !linked; $("#profile-link").hidden = linked || !(me && me.signupFlow === "v2"); $("#profile-unlink").hidden = !linked;
    $("#profile-provider").textContent = PROVIDER_LABEL[u.provider] || "Google";
    $("#profile-home").textContent = u.home ? `${u.home.name}, ${countryName(u.home.country)}` : "No home community yet";
    $("#username-input").value = u.handle || "";
    $("#username-err").hidden = true;
    // each row's summary says what is set, so a closed row still answers "what is my username / wallet"
    $("#profile-username-meta").textContent = u.handle ? `@${u.handle}` : "Pick one";
    $("#profile-wallet-meta").textContent = linked ? mask(u.wallet) : "Not linked";
    $("#profile-wallet-meta").classList.toggle("mono", linked);
    renderEmailView(u); renderPhoneView(u); renderGoogleView(u);
    $("#email-form").hidden = true; $("#email-code-form").hidden = true; $("#phone-form").hidden = true;
    $("#contact-err").hidden = true; googleNote(""); googlePassword(false); // (a note from an earlier visit is not news now)
    if (profiles) profiles.openModal(me);
    $("#profile-modal").hidden = false;
  }
  function closeProfile() { $("#profile-modal").hidden = true; }
  // e-mail: verified badge or an add/verify flow (the code comes from /api/auth/email/start)
  let pendingEmail = "";
  function renderEmailView(u) {
    const v = $("#email-view");
    if (u.contact_email) {
      v.replaceChildren(el("span", "verified-pill", `✓ ${u.contact_email}`),
        (() => { const b = el("button", "link-btn link-btn--tiny"); b.type = "button"; b.textContent = "Change";
          b.addEventListener("click", () => { $("#email-form").hidden = false; $("#email-code-form").hidden = true; $("#email-input").focus(); }); return b; })(),
        (() => { const b = el("button", "link-btn link-btn--tiny"); b.type = "button"; b.textContent = "Remove";
          b.addEventListener("click", async () => { const r = await api("/api/me/contact/email/remove", {}); if (r.ok) { me.user.contact_email = null; renderEmailView(me.user); toast("E-mail removed"); } }); return b; })());
      $("#email-desc").textContent = "Verified, and not a way to log in. Not used for anything yet. You can remove it any time.";
      $("#profile-email-meta").textContent = u.contact_email;
    } else {
      v.replaceChildren((() => { const b = el("button", "link-btn link-btn--tiny"); b.type = "button"; b.textContent = "Add";
        b.addEventListener("click", () => { $("#email-form").hidden = false; $("#email-input").focus(); }); return b; })());
      $("#email-desc").textContent = "Optional, and not a way to log in. Not used for anything yet. You can remove it any time.";
      $("#profile-email-meta").textContent = "Not added";
    }
  }
  /*
   * Google sign-in (the new sign-up only): log in with Google too. An account made with Google has it already. One made with an e-mail
   * (or a wallet) adds it here: POST /api/me/google/add answers Google's own page, the person picks their Google account there, and
   * Google sends them back to /dashboard?google=<code>#profile (googleBounce). Adding a way to log in follows the rule of a password
   * change (src/auth.js handleGoogleAdd): an account with a password types it here (the server answers reprove + password), one with only
   * a wallet confirms with it (the "confirm it's you" sheet), one with neither logs in again if its login is older than 30 minutes.
   * Remove takes the added one off and logs out the other browsers; the way the account was made always stays. /api/me says only
   * whether one was added (user.googleAdded), never which Google account.
   */
  const GOOGLE_SAID = {
    linked: "Google sign-in added. You can now log in with Google too.",
    already: "That Google account already logs you in to this account. Nothing changed.",
    google_taken: "That Google account already logs in to another Vicinity account, so it can't be added here. Pick another Google account.",
    has_google: "Your account already has a Google sign-in. Remove it first to add a different one.",
    reprove: (d) => (d.password ? "For your safety, type your password to add Google."
      : d.relogin ? "For your safety, adding a way to log in needs a fresh login. Log in again, then add Google within 30 minutes."
      : "For your safety, confirm it's you with your wallet first, then tap Add again."),
    bad_credentials: "That password isn't right. Forgot it? Log out and use “Forgot or never set a password?” on the Log in tab.",
    login_expired: "That took too long, or another tab or login got in the way. Nothing was added. Please try again.",
    login_cancelled: "Cancelled at Google. Nothing was added.",
    login_failed: "Google didn't answer properly. Nothing was added. Please try again.",
    login_unavailable: "Google sign-in is having trouble right now. Nothing was added. Please try again in a few minutes.",
    changed_retry: "Something changed at that very moment. Nothing was added. Please try again.",
    link_new: (d) => COMMON_ERR.link_new(d),
  };
  /** A line under the Google row (empty text hides it); `relogin` adds "Log in again" (the server asked for a fresh login). */
  function googleNote(text, relogin = false) {
    const e = $("#google-err");
    e.replaceChildren(...(text ? [text] : []));
    if (relogin) {
      const b = el("button", "link-btn link-btn--tiny"); b.type = "button"; b.textContent = "Log in again";
      b.addEventListener("click", async () => { await api("/api/auth/logout", {}); location.assign("/connect?mode=login&error=relogin_confirm"); });
      e.append(" ", b);
    }
    e.hidden = !text;
  }
  /** The "type your password" step under the row (and, for an account with a wallet, "Confirm with my wallet instead"); false hides it. */
  function googlePassword(on) {
    $("#google-pw-form").hidden = !on; $("#google-pw").value = "";
    $("#google-pw-alt").hidden = !(on && me && me.user && me.user.wallet);
    if (on) $("#google-pw").focus();
  }
  function renderGoogleView(u) {
    const sec = $("#google-sec"), v = $("#google-view");
    sec.hidden = !(me && me.signupFlow === "v2");
    if (sec.hidden) return;
    const button = (label, fn) => { const b = el("button", "link-btn link-btn--tiny"); b.type = "button"; b.textContent = label; b.addEventListener("click", () => fn(b)); return b; };
    if (u.provider === "google") {
      $("#profile-google-meta").textContent = "On";
      $("#google-desc").textContent = "You made your account with Google: it is how you log in.";
      v.replaceChildren();
    } else if (u.googleAdded) {
      $("#profile-google-meta").textContent = "Added";
      $("#google-desc").textContent = "You can log in with Google too, as well as the way you made your account.";
      v.replaceChildren(button("Remove", removeGoogle));
    } else if (W.inWalletApp()) { // Google doesn't allow its log-in inside a wallet app's browser (the Log in tab says the same)
      $("#profile-google-meta").textContent = "Not added";
      $("#google-desc").textContent = "Google doesn't work inside a wallet app. To add it, open your dashboard in Safari or Chrome.";
      v.replaceChildren();
    } else {
      $("#profile-google-meta").textContent = "Not added";
      $("#google-desc").textContent = "Log in with Google too, as well as the way you made your account.";
      v.replaceChildren(button("Add", (b) => addGoogle(b)));
    }
  }
  /**
   * Add: ask the server, and go to Google when it agrees. `body` = { current } once the password was typed. Asked to confirm: the password
   * step (an account with a password), the wallet's "confirm it's you" sheet then once more (a wallet and no password), or "Log in again".
   */
  async function addGoogle(b, body = {}) {
    googleNote(""); if (b) b.disabled = true;
    let r = (await api("/api/me/google/add", body)) || {};
    if (r.error === "reprove" && !r.password && !r.relogin && (await askProof(r))) r = (await api("/api/me/google/add", {})) || {};
    if (r.ok && /^https:\/\/accounts\.google\.com\//.test(String(r.url))) { location.assign(r.url); return; } // off to Google, then back here
    if (b) b.disabled = false;
    googlePassword(r.error === "reprove" ? Boolean(r.password) : r.error === "bad_credentials");
    googleNote(errText(GOOGLE_SAID, r, "Couldn't start. Please try again."), r.error === "reprove" && Boolean(r.relogin));
  }
  $("#google-pw-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const current = $("#google-pw").value;
    if (!current) return $("#google-pw").focus();
    addGoogle($("#google-pw-form button"), { current });
  });
  $("#google-pw-wallet").addEventListener("click", async () => { if (await askProof({})) { googlePassword(false); addGoogle(null); } });
  async function removeGoogle(b) {
    if (!confirm("Remove Google sign-in? You will log in the way you made your account, and your other browsers are logged out.")) return;
    googleNote(""); b.disabled = true;
    const r = (await api("/api/me/google/remove", {})) || {};
    b.disabled = false;
    if (!r.ok) return googleNote(errText(GOOGLE_SAID, r, "Couldn't remove it. Please try again."));
    me.user.googleAdded = false; renderGoogleView(me.user); toast(r.removed ? "Google sign-in removed. Other browsers are logged out." : "Google sign-in removed");
  }
  /**
   * Back from Google (?google=<code>, read once): the Profile is open (#profile); a success is a toast, anything else a line in the row. Only
   * the map's OWN codes count (a link with ?google=valueOf or constructor would otherwise reach Object.prototype and stop the page's start).
   */
  function googleBounce(code) {
    if (!Object.prototype.hasOwnProperty.call(GOOGLE_SAID, code) || !me || me.signupFlow !== "v2") return;
    if (code === "linked" || code === "already") return toast(GOOGLE_SAID[code]);
    $("#google-sec").open = true;
    googleNote(errText(GOOGLE_SAID, { error: code }, ""), false);
  }
  function renderPhoneView(u) {
    const v = $("#phone-view");
    $("#profile-phone-meta").textContent = u.phone || "Not added";
    if (u.phone) {
      v.replaceChildren(el("span", null, u.phone),
        (() => { const b = el("button", "link-btn link-btn--tiny"); b.type = "button"; b.textContent = "Change";
          b.addEventListener("click", () => { $("#phone-input").value = u.phone; $("#phone-form").hidden = false; $("#phone-input").focus(); }); return b; })(),
        (() => { const b = el("button", "link-btn link-btn--tiny"); b.type = "button"; b.textContent = "Remove";
          b.addEventListener("click", async () => { const r = await api("/api/me/phone", { phone: "" }); if (r.ok) { me.user.phone = null; renderPhoneView(me.user); toast("Phone removed"); } }); return b; })());
    } else {
      v.replaceChildren((() => { const b = el("button", "link-btn link-btn--tiny"); b.type = "button"; b.textContent = "Add";
        b.addEventListener("click", () => { $("#phone-form").hidden = false; $("#phone-input").focus(); }); return b; })());
    }
  }
  /* the header username button IS the profile button (site.js hooks it up) */
  window.V.openProfile = openProfile;
  $("#profile-close").addEventListener("click", closeProfile);
  $("#profile-modal").addEventListener("click", (e) => { if (e.target.id === "profile-modal") closeProfile(); });
  $("#profile-copy").addEventListener("click", () => me && copy(me.user.wallet, "Wallet address copied"));
  // Unlink: a fresh proof by that wallet (the server asks, askProof answers), refused while a seat, an application or a squad place depends on it
  $("#profile-unlink").addEventListener("click", async () => {
    if (!me || !me.user.wallet) return;
    // the 7 days after a wallet joined from another app, in a browser logged in before: that wallet's own proof is not the way (on a
    // phone it lives in the wallet app, whose sessions may not unlink then): "Remove it" is, and it logs that app out too
    if (me.walletNew && me.walletNew.notMe) { closeProfile(); return removeWallet(); }
    if (!confirm("Unlink this wallet? Your rank, badges and founder eligibility go with it until you link one again.")) return;
    const r = await sensitive(() => api("/api/me/wallet/unlink", {}));
    if (!r || !r.ok) return toast(r && r.error === "seat_or_application" ? "Resign or withdraw first." : errText({ reprove: "Please confirm it's you with your wallet first." }, r || {}, "Couldn't unlink. Try again."));
    toast("Wallet unlinked"); linkedNow = false;
    try { localStorage.removeItem(WCARD_SKIP); } catch {}
    await refresh(); openProfile();
  });
  $("#profile-logout").addEventListener("click", async () => { await api("/api/auth/logout", {}); location.assign("/"); });
  $("#username-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("#username-err"); err.hidden = true;
    const r = await sensitive(() => api("/api/me/username", { username: $("#username-input").value.trim() }));
    if (!r || !r.ok) { err.textContent = errText(USERNAME_ERR, r || {}, "Couldn't save that. Try again."); err.hidden = false; return; }
    me.user.handle = r.username; identity(me);
    $("#username-input").value = r.username; toast("Username updated ✓");
  });
  $("#email-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("#contact-err"); err.hidden = true;
    pendingEmail = $("#email-input").value.trim().toLowerCase();
    const r = await api("/api/auth/email/start", { email: pendingEmail });
    if (!r.ok) { err.textContent = r.error === "bad_email" ? "That doesn't look like an e-mail address." : r.error === "too_soon" ? "We just sent a code — wait a minute before asking again." : "Couldn't send the code. Try again."; err.hidden = false; return; }
    $("#email-form").hidden = true; $("#email-code-form").hidden = false; $("#email-code-input").focus();
    toast("Code sent — check your inbox");
  });
  $("#email-code-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("#contact-err"); err.hidden = true;
    const r = await api("/api/me/contact/email/verify", { email: pendingEmail, code: $("#email-code-input").value });
    if (!r.ok) {
      err.textContent = r.error === "code_wrong" ? `Wrong code${r.left != null ? ` (${r.left} tries left)` : ""}.` : r.error === "code_expired" ? "That code expired. Send a new one." : r.error === "email_taken" ? "That e-mail is someone else's sign-in. Use a different one." : "Couldn't verify. Try again.";
      err.hidden = false; return;
    }
    me.user.contact_email = r.email; renderEmailView(me.user);
    $("#email-code-form").hidden = true; $("#email-code-input").value = ""; toast("E-mail verified ✓");
  });
  $("#phone-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("#contact-err"); err.hidden = true;
    const r = await api("/api/me/phone", { phone: $("#phone-input").value.trim() });
    if (!r.ok) { err.textContent = r.error === "bad_phone" ? "That doesn't look like a phone number." : "Couldn't save that. Try again."; err.hidden = false; return; }
    me.user.phone = r.phone; renderPhoneView(me.user);
    $("#phone-form").hidden = true; toast("Phone saved ✓");
  });

  /* ---------- customizable card layout ---------- */
  // Drag-to-reorder (touch + mouse) with per-card column move, saved per user in
  // localStorage. Temporary scaffolding so the layout can be arranged by hand.
  const LAYOUT_LABELS = { "role-home": "Your role", portfolio: "Portfolio", squad: "Squad founding", progress: "Founder path", coin: "City coin", feed: "Community feed", trade: "Buy & swap", community: "Your community", national: "Your country", badges: "Badges", mod: "Moderator tools", request: "Ask for your town" };
  let layoutDef = null, layoutEditing = false;
  const layoutKey = () => `vicinity:dash-layout:${me && me.user ? me.user.id : "anon"}`;
  // hidden cards (the role panel, squad, moderator tools) keep their slot too, so they appear in the right place when they show up
  const layoutCards = (col) => [...col.querySelectorAll(":scope > section.card")].filter((c) => c.id);
  const layoutRead = () => ({ main: layoutCards($("#col-main")).map((c) => c.id), side: layoutCards($("#col-side")).map((c) => c.id) });
  const layoutSave = () => { try { localStorage.setItem(layoutKey(), JSON.stringify(layoutRead())); } catch {} };
  function layoutLoad() {
    try {
      const l = JSON.parse(localStorage.getItem(layoutKey()));
      return l && Array.isArray(l.main) && Array.isArray(l.side) ? l : null;
    } catch { return null; }
  }
  function layoutApply(l) {
    const byId = {};
    $$("#col-main > section.card, #col-side > section.card").forEach((c) => { if (c.id) byId[c.id] = c; });
    const main = $("#col-main"), side = $("#col-side"), seen = new Set();
    const put = (col, id) => { const c = byId[id]; if (c && !seen.has(id)) { col.append(c); seen.add(id); } };
    l.main.forEach((id) => put(main, id));
    l.side.forEach((id) => put(side, id));
    // a card the saved layout has never seen (added since it was saved) goes right after the card that precedes it by default
    if (layoutDef) {
      for (const [col, ids] of [[main, layoutDef.main], [side, layoutDef.side]]) {
        ids.forEach((id, i) => {
          const c = byId[id]; if (!c || seen.has(id)) return;
          seen.add(id);
          const prev = ids.slice(0, i).reverse().map((x) => byId[x]).find((x) => x && x.parentElement === col);
          if (prev) prev.after(c); else col.prepend(c);
        });
      }
    }
  }
  function layoutDrag(card, handle) {
    handle.addEventListener("pointerdown", (e) => {
      if (e.button != null && e.button !== 0) return;
      e.preventDefault();
      try { handle.setPointerCapture(e.pointerId); } catch {}
      const rect = card.getBoundingClientRect();
      const ghost = card.cloneNode(true);
      ghost.classList.add("layout-ghost");
      ghost.querySelector(":scope > .layout-bar")?.remove();
      ghost.style.width = `${rect.width}px`;
      ghost.style.left = `${rect.left}px`;
      ghost.style.top = `${rect.top}px`;
      document.body.append(ghost);
      card.classList.add("card--dragging");
      let target = null;
      const clear = () => {
        $$(".drop-before, .drop-after").forEach((x) => x.classList.remove("drop-before", "drop-after"));
        $$(".dash-col.drop-target").forEach((x) => x.classList.remove("drop-target"));
      };
      const move = (ev) => {
        ghost.style.left = `${ev.clientX - rect.width / 2}px`;
        ghost.style.top = `${ev.clientY - 40}px`;
        if (ev.clientY < 70) window.scrollBy(0, -14);
        else if (ev.clientY > window.innerHeight - 70) window.scrollBy(0, 14);
        clear(); target = null;
        const under = document.elementFromPoint(ev.clientX, ev.clientY);
        const col = under && under.closest ? under.closest(".dash-col") : null;
        if (!col) return;
        const cards = [...col.querySelectorAll(":scope > section.card")].filter((c) => c !== card && !c.hidden);
        for (const c of cards) {
          const r = c.getBoundingClientRect();
          if (ev.clientY < r.top + r.height / 2) { target = { card: c, before: true }; c.classList.add("drop-before"); return; }
        }
        const last = cards[cards.length - 1];
        if (last) { target = { card: last, before: false }; last.classList.add("drop-after"); }
        else { target = { col }; col.classList.add("drop-target"); }
      };
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        ghost.remove();
        card.classList.remove("card--dragging");
        clear();
        if (target) {
          if (target.col) target.col.append(card);
          else if (target.before) target.card.before(card);
          else target.card.after(card);
          layoutSave();
        }
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    });
  }
  function layoutDecorate(card) {
    if (card.querySelector(":scope > .layout-bar")) return;
    const bar = el("div", "layout-bar");
    bar.append(el("span", "layout-bar__label", LAYOUT_LABELS[card.id] || card.id));
    const handle = el("button", "layout-handle", "⋮⋮ drag");
    handle.type = "button";
    const mv = el("button", "layout-move", card.parentElement.id === "col-main" ? "→ side" : "→ main");
    mv.type = "button";
    mv.addEventListener("click", () => {
      const other = card.parentElement.id === "col-main" ? $("#col-side") : $("#col-main");
      other.append(card);
      mv.textContent = other.id === "col-main" ? "→ side" : "→ main";
      layoutSave();
    });
    bar.append(handle, mv);
    card.prepend(bar);
    layoutDrag(card, handle);
  }
  function layoutSetEdit(on) {
    layoutEditing = on;
    document.body.classList.toggle("layout-edit", on);
    $("#layout-edit").textContent = on ? "✓ Done" : "🎛 Customize layout";
    $("#layout-reset").hidden = !on;
    $$("#col-main > section.card, #col-side > section.card").forEach((c) => {
      if (on) { if (!c.hidden) layoutDecorate(c); }
      else c.querySelector(":scope > .layout-bar")?.remove();
    });
  }
  function layoutInit() {
    if (!$("#col-main") || !$("#col-side") || !$("#layout-edit")) return;
    layoutDef = layoutRead();
    const saved = layoutLoad();
    if (saved) layoutApply(saved);
    $("#layout-edit").addEventListener("click", () => layoutSetEdit(!layoutEditing));
    $("#layout-reset").addEventListener("click", () => {
      try { localStorage.removeItem(layoutKey()); } catch {}
      if (layoutDef) layoutApply(layoutDef);
      toast("Layout reset to the default.");
    });
  }

  /* ---------- signed out: the example dashboard (#dash-out .dpv) comes alive once ---------- */
  // Its markup already holds every value, so with reduced motion, without IntersectionObserver or without this script it simply shows
  // them. Otherwise it is "armed" just before #dash-out appears (numbers at their start, bar empty, next steps lowered) and each piece
  // plays once when it is on screen: the numbers count (a 1.3 s animation frame loop that ends), the bar fills, the next steps slide in.
  function preview() {
    const box = $("#dash-out .dpv");
    if (!box || window.V.reduced || !("IntersectionObserver" in window)) return;
    const nums = $$("[data-dpv-to]", box);
    const show = (n, v) => { n.textContent = (n.dataset.dpvPre || "") + (n.dataset.dpvFmt === "compact" ? compact(v) : fmt(v)) + (n.dataset.dpvSuf || ""); };
    const count = (n) => {
      const from = Number(n.dataset.dpvFrom || 0), to = Number(n.dataset.dpvTo), t0 = performance.now(), ms = 1300;
      const step = (t) => {
        const k = Math.min(1, Math.max(0, t - t0) / ms);
        show(n, Math.round(from + (to - from) * (1 - (1 - k) ** 3)));
        if (k < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    };
    box.classList.add("is-armed");
    for (const n of nums) show(n, Number(n.dataset.dpvFrom || 0));
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        io.unobserve(e.target);
        if (e.target.dataset.dpvTo) setTimeout(() => count(e.target), 350);
        else e.target.classList.add("is-on");
      }
    }, { threshold: 0.6 });
    for (const n of [...nums, ...$$(".dpv__bar, .dpv__todos", box)]) io.observe(n);
  }

  /** A visitor inside a known wallet app (not Instagram's browser): one tap signs in with that wallet; anywhere else, Join or log in. */
  function guestCta() {
    const k = WA.here(), a = $("#out-cta");
    if (!k) { a.textContent = "Join or log in →"; a.href = "/connect"; $("#out-cta-note").textContent = "Takes a minute, with Google or e-mail. Your wallet comes later, from your dashboard: free, one signature."; return; }
    a.textContent = `Sign in with ${k.name}`; a.href = `/connect?mode=login&with=${k.id}`;
    $("#out-cta-note").textContent = "One free signature. Nothing is paid or moved. New here? Join with Google or e-mail in Safari or Chrome.";
  }

  /* ---------- start ---------- */
  (async () => {
    // someone whose last visit was the tabbed dashboard sees placeholders while /api/me loads (the key only exists with the switch on);
    // for a guest (no sign-in remembered in this browser: theme.js marks the page before its first paint) style.css already holds the
    // signed-out page's room, unseen, so the roles under it never jump down when it shows (on a computer they dropped 839 px)
    const out = $("#dash-out");
    guestCta(); W.onChange(guestCta); // the signed-out page's button (#dash-out shows only for a visitor; a wallet app's wallet can turn up a moment late)
    try { if (localStorage.getItem(V2_KEY) === "1") $("#dash-skel").hidden = false; } catch {}
    const d = await api("/api/me");
    const unhold = () => out.classList.remove("is-pending"); // the held room gives way, in the same task as what takes its place
    const tabbed = d.dashboardV2 === true && d.signedIn && d.user && d.user.home;
    if (!tabbed) { $("#dash-skel").hidden = true; if (d.dashboardV2 !== true) { try { localStorage.removeItem(V2_KEY); } catch {} } }
    if (!d.signedIn) {
      if (d.pending || d.proof) { location.assign("/connect"); return; }
      unhold();
      preview();
      out.hidden = false; return;
    }
    // a member: the tabbed dashboard's placeholders while its code loads (in the room a guest's page held: a first visit after signing in)
    if (tabbed) { $("#dash-skel").hidden = false; unhold(); }
    me = d;
    // ?welcome=1 (the account was just made), ?linked=1 (the wallet was just linked) and ?google= (back from adding Google sign-in) are
    // moments, not places: read once, then taken off the address bar
    const welcome = params.get("welcome"), linked = params.get("linked"), googleSaid = params.get("google");
    if (welcome || linked || googleSaid) {
      params.delete("welcome"); params.delete("linked"); params.delete("google");
      const q = String(params);
      try { history.replaceState(null, "", location.pathname + (q ? `?${q}` : "") + location.hash); } catch {}
    }
    if (linked && d.user.wallet) linkedNow = true;
    // a wallet app's wallet can turn up a few seconds after the page drew: the card is chosen again then (inside Phantom it is the "next
    // time" tip, never Safari's "Connect Phantom", which would leave for phantom.com)
    W.onChange(() => { if (me && me.signedIn && me.user) { walletCard(me); if (v2) renderTrade(); } }); // (the tabbed Buy card follows: a wallet app's browser buys on the page)
    if (welcome) document.body.dataset.welcome = "1"; // the parameter is gone from the address bar: profile.js reads this (the profiles notice waits)
    identity(d);
    if (!d.user.home) { unhold(); onboard(d); return; }
    if (tabbed) {
      // the tabbed dashboard's code is fetched now, before the page shows, so the old layout never flashes; if it fails, today's dashboard
      v2 = await new Promise((done) => {
        const s = document.createElement("script"); s.src = "/dashboard-v2.js";
        const t = setTimeout(() => done(null), 4000);
        s.onload = () => { clearTimeout(t); done(window.VDash || null); };
        s.onerror = () => { clearTimeout(t); done(null); };
        document.head.append(s);
      });
      $("#dash-skel").hidden = true;
      if (v2) v2.init({ me: () => me, coin: () => ({ coin: coinData, vicMint, pairs: coinPairs }), openProfile, refresh: () => refresh(), countryName,
        // a phone's Safari / Chrome with the wallet linked: the wallet card is the one way to buy (in the wallet app), the Buy card steps back
        buyInApp: () => Boolean(me && me.user && me.user.wallet && me.signupFlow === "v2" && phoneBrowser()) });
    }
    unhold();
    $("#dash-main").hidden = false;
    render(d);
    if (!v2) layoutInit();
    if (v2) v2.start();
    else if (location.hash === "#profile") {
      history.replaceState(null, "", location.pathname + location.search);
      openProfile();
    }
    setupComposer(); loadFeed(true); loadMod(); loadTowns();
    reveal();
    if (welcome) showWelcome(d);
    if (googleSaid) googleBounce(googleSaid);
    if (linked && d.user.wallet) { const k = appNamed(d.user.walletApp); toast(k ? `${k.name} connected ✓` : "Wallet linked ✓"); const r = $("#wallet-card").getBoundingClientRect(); burst(r.left + r.width / 2, r.top + 40); }
    if (!v2 && params.get("claim")) $("#progress").scrollIntoView({ block: "center" });
    setInterval(() => { if (!document.hidden) refresh(); }, 60_000);
  })();
})();
