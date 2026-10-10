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
  // the tabbed dashboard (DASHBOARD_V2=on): window.VDash exists only then; the flag-off page keeps its emoji and its buttons as they were
  const tabbed = () => Boolean(window.VDash);

  /* ---------- the shared icon set (SPEC "Icons": 24 viewBox, stroke 1.7, currentColor), built as SVG nodes, never from text ---------- */
  const ICONS = {
    pin: [["path", { d: "M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z" }], ["circle", { cx: 12, cy: 10, r: 2.4 }]],
    idcard: [["rect", { x: 3.5, y: 5.5, width: 17, height: 13, rx: 2.5 }], ["circle", { cx: 9, cy: 11, r: 2 }], ["path", { d: "M6 15.5c.6-1.4 1.7-2 3-2s2.4.6 3 2M14 10h3.5M14 13h3.5" }]],
    city: [["path", { d: "M3.5 20.5h17M5.5 20.5V9l5-3v14.5M10.5 20.5V11h8v9.5M13.5 14h2M13.5 17h2M7.5 12h1M7.5 15h1" }]],
    link: [["path", { d: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" }], ["path", { d: "M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" }]],
    rocket: [["path", { d: "M12 3c3 2.2 4.5 5.6 4.5 9.3l-1.8 3.2H9.3l-1.8-3.2C7.5 8.6 9 5.2 12 3z" }], ["circle", { cx: 12, cy: 9.8, r: 1.6 }], ["path", { d: "M9.3 15.5 7 19l3-1M14.7 15.5 17 19l-3-1M12 17.5V21" }]],
    check: [["path", { d: "m5 12.5 4.5 4.5L19 7.5" }]],
    medal: [["circle", { cx: 12, cy: 15, r: 5 }], ["path", { d: "M8.5 10.5 6 3.5h4l2 5 2-5h4l-2.5 7" }]],
    trophy: [["path", { d: "M7.5 4.5h9v4a4.5 4.5 0 0 1-9 0z" }], ["path", { d: "M7.5 6.5h-3a3 3 0 0 0 3 3.5M16.5 6.5h3a3 3 0 0 1-3 3.5M12 13v3.5M8.5 20h7M9.5 20l.5-3.5h4l.5 3.5" }]],
    star: [["path", { d: "m12 3.8 2.5 5.1 5.6.8-4 4 1 5.6-5.1-2.7-5 2.7.9-5.6-4-4 5.6-.8z" }]],
    chat: [["path", { d: "M20 12.5a7.5 7.5 0 0 1-11 6.6L4 20l1-4.2A7.5 7.5 0 1 1 20 12.5z" }]],
    coin: [["circle", { cx: 12, cy: 12, r: 8.5 }], ["path", { d: "M12 7.5v9M9.5 9.5h3.75a1.75 1.75 0 0 1 0 3.5h-2.5a1.75 1.75 0 0 0 0 3.5h3.75" }]],
    globe: [["circle", { cx: 12, cy: 12, r: 8.5 }], ["path", { d: "M3.5 12h17M12 3.5c2.4 2.4 3.5 5.3 3.5 8.5s-1.1 6.1-3.5 8.5c-2.4-2.4-3.5-5.3-3.5-8.5s1.1-6.1 3.5-8.5z" }]],
    crown: [["path", { d: "M4 17.5 3 8l5 4 4-6.5 4 6.5 5-4-1 9.5z" }], ["path", { d: "M4.5 20.5h15" }]],
    shield: [["path", { d: "M12 3 5 6v5.5c0 4.2 2.9 7.9 7 9.5 4.1-1.6 7-5.3 7-9.5V6l-7-3z" }]],
    palette: [["path", { d: "M12 3.5a8.5 8.5 0 1 0 0 17c1.2 0 1.8-.8 1.8-1.7 0-1.3-1-1.6-1-2.6 0-.9.7-1.5 1.6-1.5H16a4.5 4.5 0 0 0 4.5-4.5c0-3.8-3.8-6.7-8.5-6.7z" }], ["circle", { cx: 7.8, cy: 11, r: 1 }], ["circle", { cx: 10.5, cy: 7.6, r: 1 }], ["circle", { cx: 15, cy: 7.8, r: 1 }]],
    wallet: [["path", { d: "M4 7.5A2.5 2.5 0 0 1 6.5 5h11v3" }], ["rect", { x: 4, y: 8, width: 16.5, height: 11, rx: 2.5 }], ["path", { d: "M16 13.5h1.5" }]],
    users: [["circle", { cx: 9, cy: 9, r: 3.2 }], ["path", { d: "M3.5 19c.6-3 2.8-4.8 5.5-4.8s4.9 1.8 5.5 4.8M15.5 6a3 3 0 0 1 0 6M17 14.4c1.9.6 3.1 2.2 3.5 4.6" }]],
    chart: [["path", { d: "M4 19.5h16" }], ["path", { d: "m4.5 15 4.5-4.5 3.5 3.5 7-7.5" }], ["path", { d: "M15 6.5h4.5V11" }]],
    swap: [["path", { d: "M4 8h14l-3.5-3.5M20 16H6l3.5 3.5" }]],
    copy: [["rect", { x: 8.5, y: 8.5, width: 11, height: 11, rx: 2.5 }], ["path", { d: "M15.5 8.5V6A1.5 1.5 0 0 0 14 4.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" }]],
    info: [["circle", { cx: 12, cy: 12, r: 8.5 }], ["path", { d: "M12 11v5M12 7.8v.2" }]],
    close: [["path", { d: "M6.5 6.5l11 11M17.5 6.5l-11 11" }]],
    chevron: [["path", { d: "m6.5 9.5 5.5 5.5 5.5-5.5" }]],
  };
  const SVG_NS = "http://www.w3.org/2000/svg";
  /**
   * An icon of the set in a tinted circle: <span class="ico [ico--sm] [ico--ok|gold|muted]"><svg>…</svg></span>, hidden from screen readers
   * (the words beside it carry the meaning). `fallback` (an emoji) is used only where SVG cannot be built (an old engine, a test DOM).
   */
  function icon(name, { tone = "", small = true, fallback = "" } = {}) {
    const box = el("span", `ico${small ? " ico--sm" : ""}${tone ? ` ico--${tone}` : ""}`);
    box.setAttribute("aria-hidden", "true");
    const parts = ICONS[name];
    if (!parts || typeof document.createElementNS !== "function") { if (fallback) box.textContent = fallback; return box; }
    const svg = document.createElementNS(SVG_NS, "svg");
    for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", width: small ? 16 : 20, height: small ? 16 : 20, fill: "none", stroke: "currentColor", "stroke-width": 1.7, "stroke-linecap": "round", "stroke-linejoin": "round", focusable: "false" })) svg.setAttribute(k, String(v));
    for (const [tag, attrs] of parts) { const n = document.createElementNS(SVG_NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v)); svg.append(n); }
    box.append(svg);
    return box;
  }

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
    return tool(tabbed() ? (seat.status === "steward" ? "Resign as Seed Steward" : "Resign as City Founder") : "Resign", async () => {
      const steward = seat.status === "steward";
      if (!confirm(steward ? "Resign as Seed Steward? Your bond is released and the city reopens for someone else."
        : "Resign as City Founder? The city reopens, and you wait 30 days before applying anywhere.")) return;
      const r = await api("/api/seats/resign", {});
      toast(r.ok ? "You resigned. The city is open again." : ctx.errText({}, r, "Couldn't resign."));
      if (r.ok) ctx.refresh();
    }, tabbed() ? "btn btn--sm danger-btn" : "link-btn");
  }

  /** What this person is, right now: icon, title, lead, status tag, meters, tools. */
  function profile(d) {
    const home = d.user.home, city = home ? home.name : "your city", cc = d.national ? d.national.country : "";
    const seat = d.founder.seat, c = d.community, weight = d.roles.weight;
    const p = { icon: "🌱", ico: ["pin", ""], title: `Member of ${city}`, lead: "", tag: null, meters: [], tools: [], notes: [], weight, danger: null };
    // the tabbed dashboard: walking away from a seat is not one of the everyday tools, it sits in the Founder tab's "Danger zone"
    const resign = (seat) => { if (tabbed()) p.danger = resignButton(seat); else p.tools.push(resignButton(seat)); };
    const invite = tool("Invite locals · copy link", () => copy(`I'm repping ${city} on Vicinity. One city, one coin, chosen by locals: join us → ${location.origin}/connect`, "Invite copied. Send it to your locals!"));

    if (seat && seat.status === "steward") {
      const q = c && c.seat && c.seat.quorum;
      p.icon = "🌟"; p.ico = ["star", "gold"]; p.title = `Seed Steward of ${seat.city}`;
      p.tag = { text: `Probation · ${daysLeft(seat.probationUntil)} days left`, cls: "tag--gold" };
      p.lead = `You founded ${seat.city} first and hold it on a bonded probation until ${date(seat.probationUntil)}. It's confirmed then, or sooner when ${q ? q.need : 50} verified local holders back it. Locals can challenge you: 10 endorsements force an election you run in.`;
      const start = Date.parse(seat.probationUntil) - 90 * 86400000;
      p.meters.push(meter("Probation", pct(Date.now() - start, Date.parse(seat.probationUntil) - start), `${daysLeft(seat.probationUntil)} days to go`));
      if (q) p.meters.push(meter("Verified local holders (early confirmation)", pct(q.have, q.need), `${q.have} of ${q.need}`));
      // a seat keeps the bar it was claimed under, even if the ladder has moved since
      p.meters.push(meter(`Your holding vs your bar (${fmt(seat.threshold)})`, pct(d.holding.amount, seat.threshold), `${fmt(d.holding.amount)} $VICINITY`, d.holding.amount >= seat.threshold ? "ok" : "bad"));
      if (seat.graceUntil) p.notes.push(`⚠️ You're below ${fmt(seat.threshold)} $VICINITY. Top up before ${when(seat.graceUntil)} or the seat is released. Moderation pauses while you're short.`);
      p.tools.push(jump("Design the city's coin", "#coin"), jump("Moderator tools", "#mod"), invite); resign(seat);
    } else if (seat && seat.status === "provisional") {
      p.icon = "👑"; p.ico = ["crown", "gold"]; p.title = `Chosen founder of ${seat.city}`;
      p.tag = { text: "Objection period", cls: "tag--warn" };
      p.lead = `${seat.city} chose you. Locals can object until ${when(seat.appealUntil)}; if none is upheld you become the founder.`;
      p.tools.push(jump("Founder path", "#progress"), invite);
    } else if (seat && seat.status === "grace") {
      p.icon = "⚠️"; p.ico = ["info", ""]; p.title = `${seat.city}: your seat is in grace`;
      p.tag = { text: `Until ${when(seat.graceUntil)}`, cls: "tag--warn" };
      p.lead = `You dropped below ${fmt(seat.threshold)} $VICINITY, so moderation is paused. Hold it again before ${when(seat.graceUntil)} or the seat reopens.`;
      p.meters.push(meter(`Your holding vs your bar (${fmt(seat.threshold)})`, pct(d.holding.amount, seat.threshold), `${fmt(d.holding.amount)} $VICINITY`, "bad"));
      p.tools.push(jump("Buy & swap", "#trade", "btn btn--primary btn--sm")); resign(seat);
    } else if (seat && seat.status === "active") {
      p.icon = "👑"; p.ico = ["crown", "gold"]; p.title = `City Founder of ${seat.city}`;
      p.tag = { text: "Active", cls: "tag--ok" };
      p.lead = `You moderate ${seat.city}, design its coin and your vote counts ×${weight}. Keep ${fmt(seat.threshold)} $VICINITY: below it, moderation pauses at once.`;
      p.meters.push(meter(`Your holding vs your bar (${fmt(seat.threshold)})`, pct(d.holding.amount, seat.threshold), `${fmt(d.holding.amount)} $VICINITY`, d.holding.amount >= seat.threshold ? "ok" : "bad"));
      p.tools.push(jump("Design the city's coin", "#coin"), jump("Moderator tools", "#mod"), invite); resign(seat);
    } else if (d.level === "holder") {
      p.icon = "🏅"; p.ico = ["medal", "ok"]; p.title = `Holder in ${city}`;
      // (the tabbed dashboard drops the pill: the meter right under it says the same percentage)
      p.tag = tabbed() ? null : { text: `Path to founder · ${d.progress.percent}%`, cls: "tag--ok" };
      p.lead = d.founder.eligible ? `You qualify to found ${city}. Apply from inside the city below.` : `You can post, vote and endorse. Your road to founding ${city} is below.`;
      p.meters.push(meter("Founder path", d.progress.percent, `${d.progress.percent}%`));
      p.tools.push(jump("Founder path", "#progress", "btn btn--primary btn--sm"), jump("Post to your city", "#feed"), invite);
    } else if (!d.user.wallet) {
      // onboarding v3: the account exists, the wallet is linked later (from the dashboard's link card, or here)
      p.tag = { text: "You are in", cls: "tag--ok" };
      p.lead = `Member of ${city}. You are in. Link a wallet to see your $VICINITY, your rank and your road to founding ${city}.`;
      // (the tabbed dashboard's first card is the wallet card with its one Connect wallet button: no second one here)
      if (!tabbed()) p.tools.push(link("Link my wallet", "/connect?mode=link", "btn btn--primary btn--sm"));
      p.tools.push(invite);
    } else {
      p.tag = { text: d.launched ? "Not holding yet" : "Early member", cls: d.launched ? "tag--warn" : "tag--ok" };
      p.lead = d.launched ? "You're signed in and local, but this wallet holds no $VICINITY yet. Holding any amount unlocks posting, voting and your rank."
        : "You're in before launch: 🌱 Early member, which can never be earned again. After launch, holding any $VICINITY unlocks posting and voting.";
      p.tools.push(link("Get $VICINITY", "/token#buy", "btn btn--primary btn--sm"), invite);
    }

    if (d.level === "manager") {
      const m = d.national && d.national.manager;
      p.icon = "🛡️"; p.ico = ["shield", "gold"]; p.title = `Country Manager · ${ctx.countryName(cc)}`;
      p.tag = { text: m ? `Term until ${date(m.endsAt)}` : "Manager", cls: "tag--gold" };
      p.lead = `You moderate ${ctx.countryName(cc)}, advise on "add my town" requests, and your vote counts ×${weight}. Powers pause if your founder seat goes into grace.`;
      if (m) { const s = Date.parse(m.startsAt); p.meters.unshift(meter("Term", pct(Date.now() - s, Date.parse(m.endsAt) - s), `${daysLeft(m.endsAt)} days left`)); }
      p.tools = [jump("Moderator tools", "#mod", "btn btn--primary btn--sm"), jump("Country election", "#national"), ...p.tools.filter((t) => t.textContent !== "Moderator tools")];
    }
    if (d.level === "admin") {
      p.icon = "⚙️"; p.ico = ["shield", "gold"]; p.title = "Admin";
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

  // the tabbed dashboard's tool tiles: one icon each, by what the tool does
  const TOOL_ICON = [[/^Founder path/, "rocket"], [/^Post to your city/, "chat"], [/^Invite locals/, "users"], [/coin/, "palette"], [/^Moderator tools/, "shield"],
    [/^Country election/, "users"], [/^Admin console/, "crown"], [/^Public log/, "chart"], [/^The rules/, "info"], [/^(Buy & swap|Get \$VICINITY)/, "coin"], [/^Link my wallet/, "wallet"]];
  function render(d, context) {
    ctx = context; lastData = d;
    const host = $("#role-home"); if (!host) return;
    const p = profile(d);
    host.hidden = false; host.dataset.level = d.level;
    const head = el("div", "role-home__head");
    const title = el("div"); title.append(el("p", "kicker", "Your role"), el("h2", "h2--sm", p.title));
    head.append(tabbed() ? icon(p.ico[0], { tone: p.ico[1], small: false, fallback: p.icon }) : el("span", "role__icon", p.icon), title);
    if (p.tag) head.append(el("span", `tag ${p.tag.cls}`, p.tag.text));
    const tools = el("div", "role-tools");
    const parts = [head, el("p", "small", p.lead), ...p.notes.map((t) => el("p", "small role-note", t)), ...p.meters];
    parts.push(Object.assign(el("p", "small role-queue"), { id: "role-queue", hidden: true }), tools);
    if (tabbed()) {
      // equal tiles, two to a row; the text links ("What my role can do") on their own line under them
      tools.classList.add("role-tools--grid");
      const more = el("p", "role-more");
      for (const t of p.tools) {
        if (t.classList.contains("link-btn")) { more.append(t); continue; }
        t.className = "btn btn--glass role-tile";
        const m = TOOL_ICON.find(([re]) => re.test(t.textContent));
        t.prepend(icon(m ? m[1] : "info"));
        tools.append(t);
      }
      // an odd number of tiles leaves half a row empty: the text link takes it, as a quiet tile
      if (tools.children.length % 2 && more.children.length === 1) {
        const t = more.children[0];
        t.className = "btn role-tile role-tile--link";
        tools.append(t);
      } else if (more.children.length) parts.push(more);
    } else tools.append(...p.tools);
    host.replaceChildren(...parts);
    renderQueue();
    renderSquad(d);
    danger(p.danger);
  }
  /** The Founder tab's "Danger zone" (the tabbed dashboard): the Resign button and what it does, folded; hidden without a seat. */
  function danger(btn) {
    const box = $("#danger-zone"), body = $("#danger-body");
    if (!box || !body || !tabbed()) return;
    box.hidden = !btn;
    if (btn) body.replaceChildren(el("p", "small muted", "You give up your seat and the city reopens. A Seed Steward's bond is released at once; a City Founder waits 30 days before applying anywhere. You are asked to confirm first."), btn);
    else body.replaceChildren();
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
    if (sq.canCreate && !d.user.wallet) { // a squad pools wallets (the server answers no_wallet): say so instead of a button that can only fail
      const a = el("a", "btn btn--glass btn--sm", "Link my wallet"); a.href = "#wallet-card";
      parts.push(el("p", "small muted", "A squad pools wallets, so link yours first: free, one signature."), a);
    } else if (sq.canCreate) parts.push(tool("Start a squad", () => act("/api/seats/squad/create", {}, "Squad started. Invite friends from your city."), "btn btn--primary btn--sm"));
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
    render, icon,
    /** The moderator queue sizes (from /api/mod) and waiting coin contracts, shown under your role. */
    queue(counts) { queue = { ...queue, ...counts, known: true }; renderQueue(); },
    redraw() { if (lastData && ctx) render(lastData, ctx); },
  };
})();
