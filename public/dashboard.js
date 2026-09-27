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
    if (!r.ok) return proofErr("Couldn't start. Try again.");
    $("#proof-sol").textContent = r.sol; $("#proof-code").hidden = false; $("#proof-start").hidden = true;
    const poll = async () => {
      if ($("#proof-modal").hidden) return;
      const c = await api("/api/auth/transfer/check", {});
      if (c.ok) { toast("Transfer found ✓"); return closeProof(true); }
      proofTimer = setTimeout(poll, 10_000);
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

  /** A location attestation for one purpose (the location itself never leaves this function except to /api/locate). */
  async function locateFor(purpose) {
    const loc = await getLocation();
    const r = await api("/api/locate", { location: loc, purpose });
    if (!r.ok) throw new Error(errText({}, r, "Couldn't check your location. Please try again."));
    return r;
  }

  /* ---------- identity ---------- */
  function identity(d) {
    const u = d.user, name = u.handle || u.name || mask(u.wallet);
    $$("[data-me-name]").forEach((e) => (e.textContent = name));
    $$("[data-me-wallet]").forEach((e) => (e.textContent = mask(u.wallet)));
    $$("[data-me-login]").forEach((e) => (e.textContent = u.provider === "x" ? `X ${u.handle || ""}`.trim() : `Google · ${u.name || ""}`));
    $("#me-avatar").textContent = initials(name);
  }

  /* ---------- first visit ---------- */
  function onboard(d) {
    $("#dash-onboard").hidden = false;
    const li = $("#ob-rank"), t = $("#ob-rank-text"), h = d.holding;
    li.classList.add("is-ok");
    if (!d.launched) t.textContent = "Ranks go live the moment $VICINITY launches. You joined before launch: 🌱 Early member badge unlocked.";
    else if (h.rank) t.textContent = `#${fmt(h.rank)} of ${fmt(h.total)} holders · top ${pctText(h.percentile)}% · ${fmt(h.amount)} $VICINITY`;
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
    const pill = $("#me-role"); pill.textContent = LEVEL[d.level] || "Member"; pill.dataset.level = d.level;
    $("#me-home").textContent = home ? `${home.name}, ${countryName(home.country)}` : "No home community yet";
    $$("[data-policy-version]").forEach((e) => (e.textContent = d.policyVersion));

    $("#d-amount").textContent = d.launched ? compact(h.amount) : "At launch";
    $("#d-amount-sub").textContent = d.launched ? `${fmt(h.amount)} $VICINITY` : "$VICINITY isn't live yet";
    $("#d-rank").textContent = h.rank ? `#${fmt(h.rank)}` : "—";
    $("#d-rank-sub").textContent = h.rank ? `of ${fmt(h.total)} · top ${pctText(h.percentile)}%` : d.launched ? (h.amount > 0 ? "ranking…" : "not holding yet") : "live at launch";
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

    renderPath(d);
    renderCommunity(d);
    renderCountry(d);
    renderBadges(d);
    $$(".role-row").forEach((r) => r.classList.toggle("is-you", r.dataset.role === d.level));
    $("#f-city").textContent = home ? home.name : "Local";
    $("#f-country").textContent = n ? countryName(n.country) : "National";
  }

  const actBtn = (label, fn, cls = "link-btn") => { const b = el("button", cls, label); b.type = "button"; b.addEventListener("click", fn); return b; };

  /* ---------- founder path ---------- */
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
      parts.push(say("Applications open after $VICINITY launches, once you've held the founder amount for 14 days in a row. There's no race: each city's first application opens a 72-hour window for everyone."));
    } else if (f.eligible) {
      const form = el("form", "apply-form");
      const ta = el("textarea"); ta.maxLength = 280; ta.rows = 2; ta.placeholder = `Why should you found ${home.name}? (optional, locals see this)`; ta.setAttribute("aria-label", "Your pitch");
      const go = el("button", "btn btn--primary btn--block", `Apply to found ${home.name} (checks your location)`); go.type = "submit";
      form.append(ta, go);
      form.addEventListener("submit", async (e) => {
        e.preventDefault(); showErr("#p-error", "");
        go.disabled = true; go.textContent = "Checking your location…";
        try {
          const r = await sensitive(async () => api("/api/seats/apply", { attestation: (await locateFor("apply")).attestation, pitch: ta.value.trim() }));
          if (!r.ok) throw new Error(errText({ not_in_city: `You're not inside ${home.name} right now.`, no_addresses: "No contract addresses in your pitch, please.",
            city_taken: "Someone just became founder here.", already_applied: "You've already applied." }, r, "Couldn't apply. Please try again."));
          toast(`📨 Applied to found ${home.name}`); const b = go.getBoundingClientRect(); burst(b.left + b.width / 2, b.top); refresh();
        } catch (x) { showErr("#p-error", x.message); }
        finally { go.disabled = false; go.textContent = `Apply to found ${home.name} (checks your location)`; }
      });
      parts.push(say(`✅ You qualify: held ${T} $VICINITY for 14 days. Apply from inside ${home.name}; others have 72 hours to apply too, then locals' endorsements count most.`), form);
    } else {
      const why = {
        no_home: "Set your home community first.",
        home_too_new: `Your home community must be set 7 days before applying: ready ${f.homeReadyAt ? date(f.homeReadyAt) : "soon"}.`,
        not_qualified: f.tenure && f.tenure.days > 0
          ? `Held ${T} for ${Math.floor(f.tenure.days)} of 14 days. Balances are checked at random times, about every hour: hold through all of them.`
          : `Hold ${T} $VICINITY to start your 14-day clock. Balances are checked at random times, so borrowed tokens don't help.`,
        below_threshold: `Hold ${T} $VICINITY right now to apply.`,
        cooldown: `You can apply again on ${f.cooldownUntil ? date(f.cooldownUntil) : "soon"} (30 days after losing a seat).`,
        city_taken: `${home ? home.name : "Your city"} already has a founder.`,
        banned: "You can't apply while banned.",
      }[f.why];
      if (why) parts.push(say(why));
    }
    // the city's seat, if it's someone else's
    if (c && c.seat && !c.seat.you) {
      const s = c.seat;
      const line = say(`${s.status === "provisional" ? "Chosen" : "Founder"}: ${s.name} (${s.wallet}) since ${date(s.since)}`);
      if (s.status === "provisional") line.append(` · objections until ${when(s.appealUntil)}`);
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
    const tk = ticker(c.name);
    $("#cc-face").textContent = tk.slice(0, 5);
    $("#cc-name").textContent = c.name;
    $("#cc-ticker").textContent = `$${tk} · city coin preview · ${countryName(c.country)}`;
    $("#cc-members").textContent = fmt(c.members);
    $("#cc-holders").textContent = d.launched ? (c.holders != null ? fmt(c.holders) : "…") : "At launch";
    $("#cc-founder").textContent = c.seat ? (c.seat.you ? `You 👑${c.seat.status !== "active" ? ` (${c.seat.status})` : ""}` : `${c.seat.name}${c.seat.status !== "active" ? ` (${c.seat.status})` : ""}`)
      : c.window ? `Choosing · ${c.window.applicants.length} applying` : "Open seat 🔥";
    const others = c.members - 1;
    $("#cc-fomo").textContent = c.seat && !c.seat.you
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

  function renderBadges(d) {
    $("#badge-grid").replaceChildren(...d.badges.map((b) => {
      const lost = d.lost.includes(b.id);
      const li = el("li", `badge ${b.earned ? "is-earned" : lost ? "is-lost" : "is-locked"}`);
      li.title = `${b.name}: ${b.detail}${b.earned ? " ✓" : ""}`;
      li.tabIndex = 0;
      li.append(el("span", "badge__icon", b.icon), el("span", "badge__name", b.grace ? `${b.name} (grace)` : b.name));
      if (!b.earned && b.progress > 0) { const p = el("span", "badge__prog"), f = el("span"); f.style.width = `${Math.round(b.progress * 100)}%`; p.append(f); li.append(p); }
      li.addEventListener("click", () => toast(`${b.icon} ${b.name}: ${b.detail}`));
      return li;
    }));
  }

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
    meta.append(el("b", null, p.author.name));
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

  /* ---------- moderator tools ---------- */
  async function loadMod() {
    const d = await api("/api/mod");
    if (!d.ok || !d.moderator) { $("#mod").hidden = true; return; }
    $("#mod").hidden = false;
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
    $("#mod-sections").replaceChildren(...sections);
  }

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

  /* ---------- start ---------- */
  (async () => {
    const d = await api("/api/me");
    if (!d.signedIn) {
      if (d.pending || d.proof) { location.assign("/connect"); return; }
      $("#dash-out").hidden = false; return;
    }
    me = d;
    identity(d);
    if (!d.user.home) { onboard(d); return; }
    $("#dash-main").hidden = false;
    render(d);
    setupComposer(); loadFeed(true); loadMod(); loadTowns();
    reveal();
    if (params.get("welcome")) toast(`Welcome to Vicinity, ${d.user.handle || d.user.name} 🎉`);
    if (params.get("claim")) $("#progress").scrollIntoView({ block: "center" });
    setInterval(() => { if (!document.hidden) refresh(); }, 60_000);
  })();
})();
