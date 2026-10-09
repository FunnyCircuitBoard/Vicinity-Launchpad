// Dashboard, by level: the "Your role" card (what you can do right now, and what's waiting for you) and the
// squad card. One dashboard page, but a member, a holder, a founder, a Seed Steward, a country manager and an
// admin each open it to a different top. Both are ordinary dashboard cards: the layout customization (drag, move
// between columns) treats them like the others, and the roles accordion at the bottom of the page holds the rules.
// Needs site.js (window.V). dashboard.js calls window.VRole.render(d, ctx) on every refresh and passes ctx:
//   { sensitive, refresh, locateFor, errText, countryName }
(() => {
  "use strict";
  const { $, el, fmt, api, toast, copy } = window.V;
  const date = (iso) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  const when = (iso) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const daysLeft = (iso) => Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 86400000));
  const pct = (a, b) => (b > 0 ? Math.max(0, Math.min(100, (a / b) * 100)) : 0);
  let ctx = null, queue = {}, lastData = null;

  /** A labelled meter: "Holding · 120,000 of 180,000". */
  function meter(label, ratio, text, tone) {
    const wrap = el("div", `role-meter${tone ? ` is-${tone}` : ""}`);
    const row = el("div", "role-meter__row"); row.append(el("span", null, label), el("strong", null, text));
    const bar = el("div", "bar"), fill = el("span"); bar.append(fill);
    requestAnimationFrame(() => (fill.style.width = `${ratio}%`));
    wrap.append(row, bar);
    return wrap;
  }
  const tool = (label, onClick, cls = "btn btn--glass btn--sm") => { const b = el("button", cls, label); b.type = "button"; b.addEventListener("click", onClick); return b; };
  // the tabbed dashboard (window.VDash exists only then) switches to the right tab first; otherwise the card is on this page
  const scrollTo = (target) => { if (window.VDash) return window.VDash.goTo(target); const t = $(target); if (t) t.scrollIntoView({ behavior: window.V.reduced ? "auto" : "smooth", block: "start" }); };
  const jump = (label, target, cls) => tool(label, () => scrollTo(target), cls);
  const link = (label, href, cls = "btn btn--glass btn--sm") => { const a = el("a", cls, label); a.href = href; return a; };

  /** Walk away from a live seat (the bond is released at once for a steward; the usual cooldown applies to a founder). */
  function resignButton(seat) {
    return tool("Resign", async () => {
      const steward = seat.status === "steward";
      if (!confirm(steward ? "Resign as Seed Steward? Your bond is released and the city reopens for someone else."
        : "Resign as City Founder? The city reopens, and you wait 30 days before applying anywhere.")) return;
      const r = await api("/api/seats/resign", {});
      toast(r.ok ? "You resigned. The city is open again." : ctx.errText({}, r, "Couldn't resign."));
      if (r.ok) ctx.refresh();
    }, "link-btn");
  }

  /** What this person is, right now: icon, title, lead, status tag, meters, tools. */
  function profile(d) {
    const home = d.user.home, city = home ? home.name : "your city", cc = d.national ? d.national.country : "";
    const seat = d.founder.seat, c = d.community, weight = d.roles.weight;
    const p = { icon: "🌱", title: `Member of ${city}`, lead: "", tag: null, meters: [], tools: [], notes: [], weight };
    const invite = tool("Invite locals · copy link", () => copy(`I'm repping ${city} on Vicinity. One city, one coin, chosen by locals: join us → ${location.origin}/connect`, "Invite copied. Send it to your locals!"));

    if (seat && seat.status === "steward") {
      const q = c && c.seat && c.seat.quorum;
      p.icon = "🌟"; p.title = `Seed Steward of ${seat.city}`;
      p.tag = { text: `Probation · ${daysLeft(seat.probationUntil)} days left`, cls: "tag--gold" };
      p.lead = `You founded ${seat.city} first and hold it on a bonded probation until ${date(seat.probationUntil)}. It's confirmed then, or sooner when ${q ? q.need : 50} verified local holders back it. Locals can challenge you: 10 endorsements force an election you run in.`;
      const start = Date.parse(seat.probationUntil) - 90 * 86400000;
      p.meters.push(meter("Probation", pct(Date.now() - start, Date.parse(seat.probationUntil) - start), `${daysLeft(seat.probationUntil)} days to go`));
      if (q) p.meters.push(meter("Verified local holders (early confirmation)", pct(q.have, q.need), `${q.have} of ${q.need}`));
      // a seat keeps the bar it was claimed under, even if the ladder has moved since
      p.meters.push(meter(`Your holding vs your bar (${fmt(seat.threshold)})`, pct(d.holding.amount, seat.threshold), `${fmt(d.holding.amount)} $VICINITY`, d.holding.amount >= seat.threshold ? "ok" : "bad"));
      if (seat.graceUntil) p.notes.push(`⚠️ You're below ${fmt(seat.threshold)} $VICINITY. Top up before ${when(seat.graceUntil)} or the seat is released. Moderation pauses while you're short.`);
      p.tools.push(jump("Design the city's coin", "#coin"), jump("Moderator tools", "#mod"), invite, resignButton(seat));
    } else if (seat && seat.status === "provisional") {
      p.icon = "👑"; p.title = `Chosen founder of ${seat.city}`;
      p.tag = { text: "Objection period", cls: "tag--warn" };
      p.lead = `${seat.city} chose you. Locals can object until ${when(seat.appealUntil)}; if none is upheld you become the founder.`;
      p.tools.push(jump("Founder path", "#progress"), invite);
    } else if (seat && seat.status === "grace") {
      p.icon = "⚠️"; p.title = `${seat.city}: your seat is in grace`;
      p.tag = { text: `Until ${when(seat.graceUntil)}`, cls: "tag--warn" };
      p.lead = `You dropped below ${fmt(seat.threshold)} $VICINITY, so moderation is paused. Hold it again before ${when(seat.graceUntil)} or the seat reopens.`;
      p.meters.push(meter(`Your holding vs your bar (${fmt(seat.threshold)})`, pct(d.holding.amount, seat.threshold), `${fmt(d.holding.amount)} $VICINITY`, "bad"));
      p.tools.push(jump("Buy & swap", "#trade", "btn btn--primary btn--sm"), resignButton(seat));
    } else if (seat && seat.status === "active") {
      p.icon = "👑"; p.title = `City Founder of ${seat.city}`;
      p.tag = { text: "Active", cls: "tag--ok" };
      p.lead = `You moderate ${seat.city}, design its coin and your vote counts ×${weight}. Keep ${fmt(seat.threshold)} $VICINITY: below it, moderation pauses at once.`;
      p.meters.push(meter(`Your holding vs your bar (${fmt(seat.threshold)})`, pct(d.holding.amount, seat.threshold), `${fmt(d.holding.amount)} $VICINITY`, d.holding.amount >= seat.threshold ? "ok" : "bad"));
      p.tools.push(jump("Design the city's coin", "#coin"), jump("Moderator tools", "#mod"), invite, resignButton(seat));
    } else if (d.level === "holder") {
      p.icon = "🏅"; p.title = `Holder in ${city}`;
      p.tag = { text: `Path to founder · ${d.progress.percent}%`, cls: "tag--ok" };
      p.lead = d.founder.eligible ? `You qualify to found ${city}. Apply from inside the city below.` : `You can post, vote and endorse. Your road to founding ${city} is below.`;
      p.meters.push(meter("Founder path", d.progress.percent, `${d.progress.percent}%`));
      p.tools.push(jump("Founder path", "#progress", "btn btn--primary btn--sm"), jump("Post to your city", "#feed"), invite);
    } else if (!d.user.wallet) {
      // onboarding v3: the account exists, the wallet is linked later (from the dashboard's link card, or here)
      p.tag = { text: "You are in", cls: "tag--ok" };
      p.lead = `Member of ${city}. You are in. Link a wallet to see your $VICINITY, your rank and your road to founding ${city}.`;
      p.tools.push(link("Link my wallet", "/connect?mode=link", "btn btn--primary btn--sm"), invite);
    } else {
      p.tag = { text: d.launched ? "Not holding yet" : "Early member", cls: d.launched ? "tag--warn" : "tag--ok" };
      p.lead = d.launched ? "You're signed in and local, but this wallet holds no $VICINITY yet. Holding any amount unlocks posting, voting and your rank."
        : "You're in before launch: 🌱 Early member, which can never be earned again. After launch, holding any $VICINITY unlocks posting and voting.";
      p.tools.push(link("Get $VICINITY", "/token#buy", "btn btn--primary btn--sm"), invite);
    }

    if (d.level === "manager") {
      const m = d.national && d.national.manager;
      p.icon = "🛡️"; p.title = `Country Manager · ${ctx.countryName(cc)}`;
      p.tag = { text: m ? `Term until ${date(m.endsAt)}` : "Manager", cls: "tag--gold" };
      p.lead = `You moderate ${ctx.countryName(cc)}, advise on "add my town" requests, and your vote counts ×${weight}. Powers pause if your founder seat goes into grace.`;
      if (m) { const s = Date.parse(m.startsAt); p.meters.unshift(meter("Term", pct(Date.now() - s, Date.parse(m.endsAt) - s), `${daysLeft(m.endsAt)} days left`)); }
      p.tools = [jump("Moderator tools", "#mod", "btn btn--primary btn--sm"), jump("Country election", "#national"), ...p.tools.filter((t) => t.textContent !== "Moderator tools")];
    }
    if (d.level === "admin") {
      p.icon = "⚙️"; p.title = "Admin";
      p.tag = { text: "Runs Vicinity within the published rules", cls: "tag--gold" };
      p.lead = "Everything that needs a decision is in the moderator tools. Launch settings, team wallets and snapshots live in the admin console.";
      p.tools = [link("Admin console", "/admin", "btn btn--primary btn--sm"), jump("Moderator tools", "#mod"), link("Public log", "/api/audit"), link("The rules", "/rules"), ...p.tools.filter((t) => t.tagName === "BUTTON" && /Resign|Invite/.test(t.textContent))];
    }
    // the rules for this level live in the roles accordion at the bottom of the page: open that row
    const row = d.level === "member" ? "holder" : d.level;
    p.tools.push(tool("What my role can do", () => {
      const r = $(`#roles details[data-role="${row}"]`);
      if (r) r.open = true;
      scrollTo("#roles");
    }, "link-btn"));
    return p;
  }

  const QUEUE_LABEL = { posts: ["reported post", "reported posts"], proposals: ["ban proposal", "ban proposals"], appeals: ["appeal", "appeals"],
    objections: ["objection", "objections"], towns: ["town request", "town requests"], coins: ["coin contract to check", "coin contracts to check"], bios: ["reported bio", "reported bios"] };
  function renderQueue() {
    const box = $("#role-queue"); if (!box) return;
    const items = Object.entries(QUEUE_LABEL).filter(([k]) => queue[k]).map(([k, [one, many]]) => `${queue[k]} ${queue[k] === 1 ? one : many}`);
    box.hidden = !queue.known;
    box.textContent = !queue.known ? "" : items.length ? `Waiting for you: ${items.join(" · ")}` : "Nothing is waiting for you right now. ✓";
  }

  function render(d, context) {
    ctx = context; lastData = d;
    const host = $("#role-home"); if (!host) return;
    const p = profile(d);
    host.hidden = false; host.dataset.level = d.level;
    const head = el("div", "role-home__head");
    const title = el("div"); title.append(el("p", "kicker", "Your role"), el("h2", "h2--sm", p.title));
    head.append(el("span", "role__icon", p.icon), title);
    if (p.tag) head.append(el("span", `tag ${p.tag.cls}`, p.tag.text));
    const tools = el("div", "role-tools"); tools.append(...p.tools);
    const parts = [head, el("p", "small", p.lead), ...p.notes.map((t) => el("p", "small role-note", t)), ...p.meters];
    parts.push(Object.assign(el("p", "small role-queue"), { id: "role-queue", hidden: true }), tools);
    host.replaceChildren(...parts);
    renderQueue();
    renderSquad(d);
  }

  /* ---------- squads: 3 to 5 verified locals pool their holdings ---------- */
  const SQUAD_ERR = {
    bad_size: "A squad needs 3 to 5 members.", member_not_qualified: "Every member must have held their share for 7 days first.",
    below_threshold: "The squad's pooled holdings are below the bar.", squad_full: "That squad is full.", already_member: "You're already in this squad.",
    squad_exists: "Your city already has a squad forming: join it.", city_taken: "This city already has a founder or steward.",
    window_closing: "This city's window has ended and is being decided. Try again in a few minutes.",
    not_local: "Only verified locals of this city can join.", not_in_city: "You're not inside the city right now.", not_launched: "Squads open when $VICINITY launches.",
    has_seat: "Someone in the squad already holds a seat.", not_member: "You're not in this squad.",
    needs_checkin: "Check in once from inside your city first (proof you're really here).", account_too_new: "Your account has to be 7+ days old.",
    home_too_new: "Your home community has to be set 7+ days first.", banned: "You can't do this while banned.", sign_in: "Your session ended. Please sign in again.",
    no_wallet: "Link a wallet first.",
  };
  const WHY_MEMBER = { not_local: "not from this city", has_seat: "already holds a seat", banned: "banned", no_balance: "holds nothing yet", not_qualified: "hasn't held their share for 7 days yet" };

  function renderSquad(d) {
    const box = $("#squad"); if (!box) return;
    const sq = d.squad, home = d.user.home;
    if (!d.launched || !home || !sq || (!sq.mine && !sq.joinable && !sq.canCreate)) { box.hidden = true; return; }
    box.hidden = false;
    const parts = [el("p", "kicker", "Squad founding"), el("h2", "h2--sm", `Found ${home.name} together`),
      el("p", "small muted", `3 to 5 verified locals pool their holdings to reach the bar (each person's share must be held 7 days). One wallet takes the seat and mints; everyone is recorded as a co-founder.`)];
    const act = async (path, body, okText) => {
      const r = await api(path, body);
      toast(r.ok ? okText : ctx.errText(SQUAD_ERR, r, "Couldn't do that.")); if (r.ok) ctx.refresh();
    };
    if (sq.canCreate) parts.push(tool("Start a squad", () => act("/api/seats/squad/create", {}, "Squad started. Invite friends from your city."), "btn btn--primary btn--sm"));
    if (sq.joinable) {
      parts.push(el("p", "small", `A squad is forming in ${home.name}: ${sq.joinable.members.join(", ")} (${sq.joinable.members.length}/${sq.joinable.max}).`));
      if (!sq.joinable.full) parts.push(tool("Join this squad", () => act("/api/seats/squad/join", { squadId: sq.joinable.id }, "You joined the squad."), "btn btn--primary btn--sm"));
    }
    if (sq.mine) {
      const m = sq.mine;
      const ul = el("ul", "req-list");
      for (const x of m.members) {
        const li = el("li", x.qualified ? "is-ok" : ""); li.append(el("strong", null, x.name), el("span", "muted", x.qualified ? `counts ${fmt(x.contribution)}` : `counts 0: ${WHY_MEMBER[x.whyNot] || "not ready"}`));
        ul.append(li);
      }
      parts.push(ul, meter(`Pooled vs the bar (${fmt(m.threshold)})`, pct(m.pooled, m.threshold), `${fmt(m.pooled)} of ${fmt(m.threshold)}`, m.ready ? "ok" : null));
      const err = el("p", "wallet__error"); err.hidden = true; err.setAttribute("role", "alert");
      if (m.status === "applied") parts.push(el("p", "small", "Your squad has applied. The window closes soon, then everyone is scored by the published formula."));
      else {
        parts.push(el("p", "small muted", m.ready ? "Ready: your squad meets the bar." : { bad_size: `Needs ${m.min} to ${m.max} members (now ${m.members.length}).`, member_not_qualified: "Every member must have held their share for 7 days.",
          below_threshold: "Pooled holdings are below the bar." }[m.whyNot] || "Not ready yet."));
        const row = el("div", "role-tools");
        row.append(tool(`Apply as a squad (checks your location)`, async (e) => {
          const b = e.currentTarget; b.disabled = true; err.hidden = true;
          try {
            const r = await ctx.sensitive(async () => api("/api/seats/squad/apply", { squadId: m.id, attestation: (await ctx.locateFor("apply")).attestation }));
            if (!r.ok) throw new Error(ctx.errText(SQUAD_ERR, r, "Couldn't apply. Please try again."));
            toast(r.steward ? `🌟 ${home.name}'s squad is Seed Steward` : "📨 Your squad applied"); ctx.refresh();
          } catch (x) { err.textContent = x.message; err.hidden = false; } finally { b.disabled = false; }
        }, `btn btn--primary btn--sm${m.ready ? "" : " is-soft"}`), tool("Leave the squad", () => act("/api/seats/squad/leave", { squadId: m.id }, "You left the squad."), "link-btn"));
        parts.push(row, err);
      }
    }
    box.replaceChildren(...parts);
  }

  window.VRole = {
    render,
    /** The moderator queue sizes (from /api/mod) and waiting coin contracts, shown under your role. */
    queue(counts) { queue = { ...queue, ...counts, known: true }; renderQueue(); },
    redraw() { if (lastData && ctx) render(lastData, ctx); },
  };
})();
