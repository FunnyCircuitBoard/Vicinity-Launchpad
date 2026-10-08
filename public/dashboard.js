// Dashboard: first-visit onboarding (rank + home community), then the live dashboard:
// identity + role, ranks, the founder path (qualify → apply → endorse → chosen → objections → founder, with grace),
// badges (re-checked every minute), community and country (elections), local / national feeds,
// moderator tools (reasons, second confirmations, ban approvals, appeals), town requests.
// Needs site.js (window.V), wallets.js (window.VW) and ticker.js.
(() => {
  "use strict";
  const { $, $$, el, api, toast, copy, fmt, compact, mask, ago, initials, getLocation, burst, reveal } = window.V;
  const W = window.VW;
  const params = new URLSearchParams(location.search);
  const LEVEL = { admin: "Admin", manager: "Country Manager", founder: "City Founder", holder: "Holder", member: "Member" };
  const REASONS = { spam: "Spam", scam: "Scam / fake token", abuse: "Abuse", illegal: "Illegal", off_topic: "Off topic", other: "Other" };
  const regionNames = (() => { try { return new Intl.DisplayNames(["en"], { type: "region" }); } catch { return null; } })();
  const countryName = (cc) => { try { return (regionNames && regionNames.of(cc)) || cc; } catch { return cc; } };
  const ticker = (name) => (window.vicinityTicker ? window.vicinityTicker.baseTicker(name) : String(name).toUpperCase().replace(/[^A-Z]/g, "").slice(0, 10));
  const pctText = (p) => (p >= 10 ? p.toFixed(1) : p >= 0.01 ? p.toFixed(2) : "<0.01");
  const date = (iso) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  const when = (iso) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const left = (iso) => { const ms = Date.parse(iso) - Date.now(); if (ms <= 0) return "closing now"; const h = Math.floor(ms / 3600000); return h >= 48 ? `${Math.floor(h / 24)} days left` : h >= 1 ? `${h}h left` : `${Math.ceil(ms / 60000)} min left`; };
  let me = null, checkedAt = 0;
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
    in_grace: "Your founder seat is in grace: hold the founder amount again to use moderation.",
    not_allowed: "Only the right moderator can do that.",
    needs_second_moderator: "That needs a second moderator: you can't confirm your own action.",
    needs_manager: "A confirmed hide can only be undone by the Country Manager or an admin.",
    reason_required: "Please give a reason (at least a few words).",
    own_post: "You can't do that on your own post.",
    not_found: "That's gone.",
  };
  const errText = (map, d, fallback) => { const f = map[d.error] || COMMON_ERR[d.error]; return typeof f === "function" ? f(d) : f || fallback; };

  /* ---------- "confirm it's you" (sensitive actions) ---------- */
  let proofDone = null, proofTimer = null;
  function closeProof(ok) {
    clearTimeout(proofTimer);
    $("#proof-modal").hidden = true;
    if (proofDone) { const d = proofDone; proofDone = null; d(ok); }
  }
  function askProof() {
    return new Promise((resolve) => {
      proofDone = resolve;
      $("#proof-error").hidden = true;
      $("#proof-code").hidden = true; $("#proof-start").hidden = false;
      const list = W.list();
      $("#proof-none").hidden = list.length > 0;
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
  /** Run a sensitive call; if the server asks, confirm with the wallet and try once more. */
  async function sensitive(call) {
    let r = await call();
    if (r && r.error === "reprove" && (await askProof())) r = await call();
    return r;
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
    const u = d.user, name = u.handle || u.name || mask(u.wallet);
    $$("[data-me-name]").forEach((e) => (e.textContent = name));
    $$("[data-me-wallet]").forEach((e) => (e.textContent = mask(u.wallet)));
    // the pass shows the sign-in method only — never the real name (privacy)
    $$("[data-me-login]").forEach((e) => (e.textContent = PROVIDER_LABEL[u.provider] || "Google"));
    $("#me-avatar").textContent = initials(name);
  }

  /* ---------- first visit ---------- */
  function onboard(d) {
    $("#dash-onboard").hidden = false;
    const li = $("#ob-rank"), t = $("#ob-rank-text"), h = d.holding;
    li.classList.add("is-ok");
    if (!d.launched) t.textContent = "Ranks go live the moment $VICINITY launches. You joined before launch: 🌱 Early member badge unlocked.";
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
    identity(d);
    const u = d.user, h = d.holding, home = u.home, c = d.community, n = d.national;
    const pill = $("#me-role"); pill.textContent = d.roles.steward && d.level === "founder" ? "Seed Steward" : LEVEL[d.level] || "Member"; pill.dataset.level = d.level;
    $("#me-home").textContent = home ? `${home.name}, ${countryName(home.country)}` : "No home community yet";
    $$("[data-policy-version]").forEach((e) => (e.textContent = d.policyVersion));

    $("#d-amount").textContent = d.launched ? compact(h.amount) : "—";
    $("#d-amount-sub").textContent = d.launched ? `${fmt(h.amount)} $VICINITY` : "live at launch";
    $("#d-rank").textContent = h.rank ? `#${fmt(h.rank)}` : "—";
    $("#d-rank-sub").textContent = h.rank ? `of ${fmt(h.total)} · top ${pctText(h.percentile)}%` : d.launched ? (h.team ? "team wallet, not ranked" : h.amount > 0 ? "ranking…" : "not holding yet") : "live at launch";
    $("#d-city-label").textContent = home ? home.name : "your city";
    $("#d-country-label").textContent = n ? countryName(n.country) : "your country";
    $("#d-crank").textContent = c && c.rank ? `#${c.rank}` : "—";
    $("#d-crank-sub").textContent = c ? (c.rank ? `of ${c.holders} holders here` : `${fmt(c.members)} member${c.members === 1 ? "" : "s"}`) : "";
    $("#d-nrank").textContent = n && n.rank ? `#${n.rank}` : "—";
    $("#d-nrank-sub").textContent = n ? (n.rank ? `of ${n.holders} holders` : `${fmt(n.members)} member${n.members === 1 ? "" : "s"}`) : "";

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

  /* ---------- founder path ---------- */
  /** Why someone can't endorse, vote or challenge (the same checks the server makes for verified locals). */
  const VOTER_WHY = {
    not_local: "Only people whose home is this city can do this.", account_too_new: "Your account had to be 7+ days old when this opened.",
    home_too_new: "Your home had to be set 7+ days before this opened.", needs_checkin: "Check in once from inside your city first (proof you're really here).", banned: "You can't do this while banned.",
  };
  const APPLY_ERR = { not_in_city: (d) => d.here ? `You're in ${d.here} right now, not your home city.` : "You're not inside your city right now.", no_addresses: "No contract addresses in your pitch, please.",
    city_taken: "Someone just became founder here.", already_applied: "You've already applied.", not_dark: "That city isn't dark long enough yet.",
    window_closing: "This city's window has ended and is being decided. Try again in a few minutes." };

  function renderPath(d) {
    const p = d.progress, f = d.founder, home = d.user.home, c = d.community;
    $("#p-city").textContent = home ? home.name : "your city";
    $("#p-pct").textContent = `${p.percent}%`;
    requestAnimationFrame(() => ($("#p-bar").style.width = `${p.percent}%`));
    $("#p-steps").replaceChildren(...p.steps.map((s) => {
      const li = el("li", s.done ? "is-ok" : "");
      li.append(el("span", "req__dot"), el("span", null, s.label));
      if (s.id === "hold" && !s.done && s.progress > 0) { const m = el("span", "mini"), fill = el("span"); fill.style.width = `${Math.round(s.progress * 100)}%`; m.append(fill); li.append(m); }
      if (s.detail && !s.done) li.append(el("span", "detail", s.detail));
      return li;
    }));

    const panel = $("#p-panel");
    const T = f.threshold ? fmt(f.threshold) : "the founder amount of";
    const say = (...nodes) => { const x = el("p", "small"); x.append(...nodes); return x; };
    const parts = [];
    if (f.seat) {
      const s = f.seat;
      if (s.status === "provisional") parts.push(say(`🎉 ${s.city} chose you! Locals can object until ${when(s.appealUntil)}; if no objection is upheld, you're the founder.`));
      else if (s.status === "steward") parts.push(say(`🌟 You're ${s.city}'s Seed Steward: probation until ${date(s.probationUntil)}, or sooner once enough verified local holders back the city. Locals can challenge you.`));
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
        home_too_new: `Your home community must be set 7 days before applying: ready ${f.homeReadyAt ? date(f.homeReadyAt) : "soon"}.`,
        not_qualified: f.tenure && f.tenure.days > 0
          ? `Held ${T} for ${Math.floor(f.tenure.days)} of 7 days. Balances are checked at random times, about every hour: hold through all of them.`
          : `Hold ${T} $VICINITY to start your 7-day clock. Balances are checked at random times, so borrowed tokens don't help.`,
        below_threshold: `Hold ${T} $VICINITY right now to apply.`,
        cooldown: `You can apply again on ${f.cooldownUntil ? date(f.cooldownUntil) : "soon"} (30 days after losing a seat).`,
        city_taken: f.whyNot ? `${home ? home.name : "Your city"} has a Seed Steward on probation. To challenge them: ${VOTER_WHY[f.whyNot] || "you need to be a verified local."}` : `${home ? home.name : "Your city"} already has a founder.`,
        banned: "You can't apply while banned.",
        has_seat: "You already hold a seat.", already_applied: "You've already applied.",
      }[f.why];
      if (why) parts.push(say(why));
    }
    // the city's seat, if it's someone else's
    if (c && c.seat && !c.seat.you) {
      const s = c.seat;
      const line = say(`${s.status === "provisional" ? "Chosen" : s.status === "steward" ? "Seed Steward" : "Founder"}: ${s.name} (${s.wallet}) since ${date(s.since)}`);
      if (s.status === "provisional") line.append(` · objections until ${when(s.appealUntil)}`);
      if (s.status === "steward") line.append(` · probation until ${date(s.probationUntil)}${s.quorum ? ` · ${s.quorum.have}/${s.quorum.need} local holders` : ""}`);
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
    const tk = c.ticker || ticker(c.name);
    $("#cc-face").textContent = tk.slice(0, 5);
    $("#pass-coin").textContent = tk.slice(0, 5);
    $("#cc-name").textContent = c.name;
    $("#cc-ticker").textContent = `$${tk} · city coin preview · ${countryName(c.country)}`;
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
    box.replaceChildren(el("p", "kicker kicker--live", `🗳️ Election open · ${left(e.closesAt)}`), list, ...(why ? [el("p", "small muted", why)] : []),
      el("p", "tiny muted", "One vote per person. Score: 50% votes, 30% service, 20% holdings capped at 2×. 90-day term."));
  }

  let btab = "earned";
  function badgeEl(d, b) {
    const lost = d.lost.includes(b.id);
    const li = el("li", `badge ${b.earned ? "is-earned" : lost ? "is-lost" : "is-locked"}`);
    li.title = `${b.name}: ${b.detail}${b.earned ? " ✓" : ""}`;
    li.tabIndex = 0;
    li.append(el("span", "badge__icon", b.icon), el("span", "badge__name", b.grace ? `${b.name} (grace)` : b.name));
    if (!b.earned && b.progress > 0) {
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
  const PLACEHOLDER = { meme: "Caption a local meme…", checkin: "Say something about where you are (optional)", talk: "Start a discussion with your neighbours…" };
  const POST_ERR = {
    holders_only: "Only $VICINITY holders can post and vote now that it's live. Holding any amount unlocks it.",
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
  };
  function setupComposer() {
    const national = scope === "country", checkin = kind === "checkin";
    $("#composer").hidden = national && checkin;
    $("#c-text").placeholder = PLACEHOLDER[kind];
    $("#c-text").maxLength = kind === "talk" ? 1000 : kind === "meme" ? 280 : 140;
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
    li.append(el("strong", null, `${{ meme: "No memes yet", checkin: "No check-ins yet", talk: "No discussions yet" }[kind]} in ${where}.`),
      el("span", null, kind === "checkin" && scope === "country" ? "Check in from your city's Local tab." : "Be the first: the first posts set the tone for everyone who joins after you."));
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

  function postEl(p, { reply = false, queue = false } = {}) {
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
    if (p.author.manager) meta.append(el("span", "tag tag--gold", "🛡️ Manager"));
    if (p.author.founder) meta.append(el("span", "tag tag--gold", `👑 ${p.author.founder}`));
    if (p.where && scope === "country") meta.append(el("span", "tag", `📍 ${p.where}`));
    meta.append(el("span", null, `· ${ago(p.at)}`));
    if (p.hidden) meta.append(el("span", "tag tag--no", p.hiddenUntil ? `Hidden until ${when(p.hiddenUntil)}` : "Hidden"));
    if (p.hideAction) meta.append(el("span", "tag", REASONS[p.hideAction.reason] || p.hideAction.reason));
    if (p.pendingBy) meta.append(el("span", "tag tag--warn", `hidden by ${p.pendingBy}, needs a 2nd moderator`));
    if (p.reports) meta.append(el("span", "tag tag--warn", `${p.reports} report${p.reports === 1 ? "" : "s"}`));
    li.append(meta);
    if (p.body) li.append(el("p", "post__body", p.kind === "checkin" && !reply ? `📍 ${p.body}` : p.body));
    if (p.image) { const img = el("img", "post__img"); img.src = p.image; img.alt = "Meme picture"; img.loading = "lazy"; li.append(img); }
    const actions = el("div", "post__actions");
    if (!reply && !queue && p.kind !== "checkin" && !p.hidden) {
      const rb = actBtn(p.replies ? `💬 ${p.replies} repl${p.replies === 1 ? "y" : "ies"}` : "💬 Reply", () => toggleReplies(li, p, rb));
      actions.append(rb);
    }
    if (p.mine && p.hidden && p.hideAction) actions.append(actBtn("Appeal", () => appeal(p.hideAction.id)));
    if (!p.mine && !p.hidden) actions.append(actBtn("Report", async () => {
      const reason = prompt("Why are you reporting this? (optional)");
      if (reason === null) return;
      const r = await api("/api/posts/report", { id: p.id, reason });
      toast(r.ok ? "Reported. Thanks for keeping your city clean." : errText(POST_ERR, r, "Couldn't report."));
    }));
    if (p.canModerate && !p.mine) {
      if (!p.hidden) actions.append(actBtn("Hide", () => reasonForm(li, "Hide for 24 h", async (reason, note) => {
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
    ul.replaceChildren(...(d.posts || []).map((r) => postEl(r, { reply: true })));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = input.value.trim(); if (!text) return;
      send.disabled = true;
      const r = await api("/api/posts", { parent: p.id, body: text });
      send.disabled = false;
      if (!r.ok) return toast(errText(POST_ERR, r, "Couldn't reply."));
      input.value = ""; ul.append(postEl(r.post, { reply: true }));
      p.replies += 1; btn.textContent = `💬 ${p.replies} repl${p.replies === 1 ? "y" : "ies"}`;
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
      const r = await api("/api/posts", body);
      if (!r.ok) throw new Error(errText(POST_ERR, r, "Couldn't post. Please try again."));
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
    bad_name: "Use 2 to 32 letters, numbers or spaces for the name (no links).",
    too_long: (d) => `That's too long (at most ${d.max} characters).`,
    no_addresses: "Contract addresses can't go in a coin's name or pitch.",
    no_links: "Links can't go in the pitch.",
    bad_pair: "Pick SOL, USDC or RAY.",
    bad_color: "Pick one of the colours.",
    bad_image: "That picture couldn't be used. Try a PNG, JPEG or WebP.",
    bad_address: "That isn't a Solana contract address.",
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
  const cityTk = () => (me && me.community ? me.community.ticker || ticker(me.community.name) : "CITY");
  const picked = (name, fallback) => (document.querySelector(`input[name='${name}']:checked`) || {}).value || fallback;
  const num = (x) => new Intl.NumberFormat(undefined, { maximumSignificantDigits: 6 }).format(x);
  const usd = (x) => new Intl.NumberFormat(undefined, { maximumFractionDigits: x < 1 ? 4 : 2 }).format(x);

  async function loadCoin() {
    const c = me && me.community; if (!c) return;
    const r = await api(`/api/coins?city=${encodeURIComponent(c.id)}`);
    if (!r || r.ok === false) return;
    coinData = r.coin || null; coinPairs = r.pairs || coinPairs; vicMint = r.vicinity || null;
    renderCoin(); renderTrade(); v2Coin();
    if (me.roles && me.roles.admin) loadCoinQueue();
  }
  function paintCoin({ name, color, logo, pair }) {
    const tk = cityTk(), face = $("#coin-art-face"), img = $("#coin-logo");
    $("#coin-art").dataset.color = color || "gold";
    $(".pass__coin").dataset.color = color || "gold";
    if (logo) { img.src = logo; img.hidden = false; } else { img.hidden = true; img.removeAttribute("src"); }
    face.textContent = tk.slice(0, 5); face.hidden = Boolean(logo);
    $("#coin-name").textContent = name;
    $("#coin-ticker").textContent = `$${tk}`;
    $("#coin-pair").textContent = pair || "chosen by the founder";
  }
  function renderCoin() {
    const c = me.community, tk = cityTk(), cd = coinData, seat = c.seat;
    // the server lets a Seed Steward design the coin too (src/roles.js); the tabbed dashboard shows them the studio
    const mine = Boolean(seat && seat.you && (seat.status === "active" || (v2 && seat.status === "steward")));
    $("#coin-city").textContent = c.name;
    $$("[data-city-ticker]").forEach((e) => (e.textContent = tk));
    const st = $("#coin-status");
    st.className = "tag " + (cd && cd.launched ? "tag--ok" : cd && cd.waiting ? "tag--warn" : cd ? "tag--gold" : "");
    st.textContent = cd && cd.launched ? "● Live" : cd && cd.waiting ? "Contract being checked" : cd ? "Designed" : "Not designed yet";
    if (!(mine && studioDirty)) paintCoin(cd ? cd : { name: c.name, color: "gold", logo: null, pair: null });
    $("#coin-pitch").textContent = cd ? cd.pitch : "";
    $("#coin-by").textContent = cd ? `Designed by ${cd.by || "the City Founder"} · updated ${date(cd.updatedAt)}` : "";
    $("#coin-contract").hidden = !(cd && cd.mint);
    if (cd && cd.mint) $("#coin-mint").textContent = cd.mint;
    $("#coin-note").textContent = mine
      ? (cd ? (cd.launched ? `${c.name}'s coin is live. Its design is locked, as the rules promise.` : "Change anything until your coin launches. Every save is public in the log.")
        : `Your coin, your call. Design ${c.name}'s coin below: everyone in ${c.name} will see it.`)
      : cd ? (cd.launched ? `The one official $${tk}. Buy or swap it in the panel on the right.` : `Designed by ${c.name}'s founder. It launches on Raydium LaunchLab.`)
      : seat ? `${seat.name}, ${c.name}'s founder, hasn't designed the coin yet. It'll appear here the moment they do.`
      : `${c.name}'s founder designs this coin: its name, logo, colour and what it's paired with. The seat is still open: see the founder path.`;
    $("#coin-studio").hidden = !mine || Boolean(cd && cd.launched);
    if (mine && !studioDirty) fillStudio();
  }
  const countPitch = () => ($("#cs-count").textContent = `${$("#cs-pitch").value.length}/200`);
  function fillStudio() {
    const cd = coinData;
    $("#cs-name").value = cd ? cd.name : me.community.name;
    $("#cs-ticker").value = `$${cityTk()}`;
    $("#cs-pitch").value = cd ? cd.pitch : "";
    const p = document.querySelector(`input[name='cs-pair'][value='${cd ? cd.pair : "SOL"}']`); if (p) p.checked = true;
    const k = document.querySelector(`input[name='cs-color'][value='${cd ? cd.color : "gold"}']`); if (k) k.checked = true;
    logoData = null; dropLogo = false;
    $("#cs-logo-remove").hidden = !(cd && cd.logo);
    countPitch();
  }
  function studioPreview() {
    studioDirty = true;
    paintCoin({ name: $("#cs-name").value.trim() || me.community.name, color: picked("cs-color", "gold"), pair: picked("cs-pair", "SOL"),
      logo: logoData ? `data:${logoData.type};base64,${logoData.b64}` : dropLogo ? null : coinData && coinData.logo });
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

  // admins: contracts founders sent, waiting for someone else to check them
  async function loadCoinQueue() {
    const r = await api("/api/coins?waiting=1");
    const list = r && r.ok ? r.waiting : [];
    $("#coin-admin").hidden = !list.length;
    if (v2) v2.coinQueue(list.length);
    window.VRole.queue({ coins: list.length });
    $("#coin-waiting").replaceChildren(...list.map((w) => {
      const li = el("li");
      const link = el("a", "mono", w.pendingMint); link.href = `https://solscan.io/token/${w.pendingMint}`; link.target = "_blank"; link.rel = "noopener";
      li.append(el("strong", null, `${w.cityName} · `), link, el("span", "tiny muted", ` · ${w.pair} pair · sent ${ago(w.pendingAt)}`));
      // the decision carries the address the admin looked at: the server records only if it is still the one waiting
      const decide = (approve, note) => sensitive(() => api("/api/coins/mint/decide", { city: w.city, mint: w.pendingMint, approve, note }));
      li.append(
        actBtn("Record it ✓", async () => { const x = await decide(true, "Checked on the blockchain"); toast(x.ok ? "Recorded: it's the official coin now ✓" : errText(COIN_ERR, x, "Couldn't do that.")); loadCoinQueue(); }),
        actBtn("Reject", () => reasonForm(li, "Reject", async (reason, note) => {
          const x = await decide(false, note || REASONS[reason]); toast(x.ok ? "Rejected" : errText(COIN_ERR, x, "Couldn't do that.")); loadCoinQueue();
        })));
      return li;
    }));
  }

  /* ---------- buy & swap: straight to Jupiter or Raydium, where you sign in your own wallet ---------- */
  let route = "vic", flipped = false, priceCache = { key: "", at: 0, p: {} }, estTimer = 0;
  function routeInfo() {
    const cd = coinData, tk = `$${cityTk()}`, cityMint = cd && cd.mint ? cd.mint : null;
    const base = route === "vic" ? [["SOL", SOL_MINT], ["$VICINITY", vicMint]]
      : route === "city" ? [[cd ? cd.pair : "SOL", cd ? cd.pairMint : SOL_MINT], [tk, cityMint]]
      : [[tk, cityMint], ["$VICINITY", vicMint]];
    const [a, b] = flipped ? [base[1], base[0]] : base;
    const missing = route !== "city" && !vicMint ? "$VICINITY" : route !== "vic" && !cityMint ? tk : null;
    return { a, b, missing, tk };
  }
  const swapSide = (m) => (m === SOL_MINT ? "SOL" : m);
  function renderTrade() {
    if (!me || !me.community) return;
    const { a, b, missing, tk } = routeInfo();
    $$("[data-city-tk]").forEach((e) => (e.textContent = tk));
    $$("#trade [data-route]").forEach((x) => x.setAttribute("aria-selected", String(x.dataset.route === route)));
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
    const section = (title, items) => { const s = el("div", "mod-section"); s.append(el("h3", null, title)); const ul = el("ul", "req-list"); ul.append(...items); s.append(ul); return s; };
    const empty = (t) => el("li", "muted small", t);
    const decide = (label, fn, cls) => actBtn(label, async () => { const r = await sensitive(fn); toast(r.ok ? "Done ✓" : errText(POST_ERR, r, "Couldn't do that.")); loadMod(); refresh(); if (r.ok) loadFeed(true); }, cls);
    const posts = el("ul", "posts posts--compact");
    posts.append(...(d.posts.length ? d.posts.map((p) => postEl(p, { reply: true, queue: true })) : [empty("No reports. All clean.")]));
    const ps = el("div", "mod-section"); ps.append(el("h3", null, "Reported and hidden posts"), posts); sections.push(ps);
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
    $("#me-checked").textContent = s < 5 ? "live · just checked" : `live · checked ${s < 60 ? s + "s" : Math.round(s / 60) + "m"} ago`;
  }, 5000);
  $("#me-copy").addEventListener("click", () => me && copy(me.user.wallet, "Wallet address copied"));
  $("#me-logout").addEventListener("click", async () => { await api("/api/auth/logout", {}); location.assign("/"); });

  /* ---------- profile & settings ---------- */
  const USERNAME_ERR = {
    bad_username: "Usernames are 3–20 characters: letters, numbers and underscores, starting with a letter.",
    username_taken: "That username is taken. Try another one.",
    username_reserved: "That name is reserved. Try another one.",
    username_similar: "That is too close to an existing username. Try another one.",
    slow_down: "You can change your username 3 times a day. Try again tomorrow.",
    reprove: "Please confirm it's you with your wallet first, then try again.",
    sign_in: "Your session ended. Please sign in again.",
  };
  function openProfile() {
    if (!me) return;
    const u = me.user, name = u.handle || u.name || mask(u.wallet);
    $("#profile-avatar").textContent = initials(name);
    $("#profile-since").textContent = `Member since ${date(u.joined)} · ${LEVEL[me.level] || "Member"}`;
    $("#profile-wallet").textContent = mask(u.wallet);
    $("#profile-provider").textContent = PROVIDER_LABEL[u.provider] || "Google";
    $("#profile-home").textContent = u.home ? `${u.home.name}, ${countryName(u.home.country)}` : "No home community yet";
    $("#username-input").value = u.handle || "";
    $("#username-err").hidden = true;
    renderEmailView(u); renderPhoneView(u);
    $("#email-form").hidden = true; $("#email-code-form").hidden = true; $("#phone-form").hidden = true;
    $("#contact-err").hidden = true;
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
      $("#email-desc").textContent = "Verified. Not used for anything yet. You can remove it any time.";
    } else {
      v.replaceChildren((() => { const b = el("button", "link-btn link-btn--tiny"); b.type = "button"; b.textContent = "Add";
        b.addEventListener("click", () => { $("#email-form").hidden = false; $("#email-input").focus(); }); return b; })());
      $("#email-desc").textContent = "Optional. Not used for anything yet. You can remove it any time.";
    }
  }
  function renderPhoneView(u) {
    const v = $("#phone-view");
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
  $("#profile-logout").addEventListener("click", async () => { await api("/api/auth/logout", {}); location.assign("/"); });
  $("#username-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("#username-err"); err.hidden = true;
    const r = await sensitive(() => api("/api/me/username", { username: $("#username-input").value.trim() }));
    if (!r || !r.ok) { err.textContent = USERNAME_ERR[r && r.error] || "Couldn't save that. Try again."; err.hidden = false; return; }
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

  /* ---------- start ---------- */
  (async () => {
    // someone whose last visit was the tabbed dashboard sees placeholders while /api/me loads (the key only exists with the switch on);
    // for a guest (no sign-in remembered in this browser: theme.js marks the page before its first paint) style.css already holds the
    // signed-out page's room, unseen, so the roles under it never jump down when it shows (on a computer they dropped 839 px)
    const out = $("#dash-out");
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
      if (v2) v2.init({ me: () => me, coin: () => ({ coin: coinData, vicMint, pairs: coinPairs }), openProfile, refresh: () => refresh(), countryName });
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
    if (params.get("welcome")) toast(`Welcome to Vicinity, ${d.user.handle || d.user.name} 🎉`);
    if (!v2 && params.get("claim")) $("#progress").scrollIntoView({ block: "center" });
    setInterval(() => { if (!document.hidden) refresh(); }, 60_000);
  })();
})();
