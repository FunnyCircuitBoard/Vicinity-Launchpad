// Vicinity: the floating "Feedback / Support" widget on every page (built in by scripts/pages/build.mjs, after site.js).
// A round button in the bottom-right corner opens a small panel: a question, a bug report or a request for a city, with an
// optional e-mail for a reply. One tap sends it to POST /api/feedback (src/feedback.js). No login needed and nothing opens in
// another window, so it works inside wallet apps' browsers too. The page's path travels with the message; a signed-in member's
// account and the browser type are read by the server from the request itself, never from here.
// Keyboard and screen readers: the button says what it does and whether the panel is open, Escape closes the panel, the keyboard
// lands on the chosen kind when it opens and goes back to the button when it closes, the three kinds are one tab stop with the
// arrow keys moving inside it, and while the Terms gate is open the whole widget is inert, like the rest of the page.
// Everything is built with createElement / textContent (the security policy allows no inline script or style).
(() => {
  "use strict";
  const V = window.V;
  if (!V || !document.body || document.getElementById("fb")) return;
  const { $, el, api } = V;
  const MAX = 1000;
  // [kind, label, what the panel says, the message box's placeholder]
  const KINDS = [
    ["question", "Question", "Ask us anything about Vicinity, $VICINITY, founders or the map.", "What would you like to know?"],
    ["bug", "Report a bug", "Tell us what you did, what you expected and what happened instead.", "What went wrong, and on which page?"],
    ["city", "Request a city", "Your city isn't on the map? Give us its name and country and we'll check its boundaries.", "Anything else we should know? (optional)"],
  ];
  const ERRORS = {
    bad_message: "Please write at least a few words.",
    bad_email: "That e-mail address doesn't look right.",
    bad_city: "Please give the city and its country.",
    slow_down: "That's plenty for now. Please try again in an hour.",
    offline: "You seem to be offline. Check the connection and try again.",
    unavailable: "Couldn't send right now. Please try again in a minute.",
  };
  const ICON_CHAT = '<svg class="fb__ico-chat" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 5.5h15a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H12l-4.5 3.5V16.5h-3a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z"/><path d="M8 10h8M8 13h5"/></svg>';
  const ICON_X = '<svg class="fb__ico-x" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>';

  /* ---------- the markup ---------- */
  const root = el("div", "fb"); root.id = "fb";
  const btn = el("button", "fb__btn"); btn.id = "fb-open"; btn.type = "button";
  btn.setAttribute("aria-label", "Feedback and support");
  btn.setAttribute("aria-haspopup", "dialog"); btn.setAttribute("aria-expanded", "false"); btn.setAttribute("aria-controls", "fb-panel");
  btn.innerHTML = ICON_CHAT + ICON_X; // static icons, no data in them

  const panel = el("section", "fb__panel"); panel.id = "fb-panel"; panel.hidden = true;
  panel.setAttribute("role", "dialog"); panel.setAttribute("aria-modal", "false"); panel.setAttribute("aria-labelledby", "fb-title");
  const head = el("div", "fb__head");
  const title = el("h2", "fb__title", "Talk to us"); title.id = "fb-title";
  const closeBtn = el("button", "fb__close", "✕"); closeBtn.id = "fb-close"; closeBtn.type = "button"; closeBtn.setAttribute("aria-label", "Close");
  head.append(title, closeBtn);
  const lead = el("p", "fb__lead"); lead.id = "fb-lead";

  const kinds = el("div", "fb__kinds"); kinds.id = "fb-kinds"; kinds.setAttribute("role", "tablist"); kinds.setAttribute("aria-label", "What is it about?");
  const tabs = KINDS.map(([kind, label]) => {
    const t = el("button", null, label); t.type = "button"; t.dataset.kind = kind;
    t.setAttribute("role", "tab"); t.setAttribute("aria-selected", "false"); t.tabIndex = -1;
    kinds.append(t);
    return t;
  });

  const form = el("form", "fb__form"); form.id = "fb-form"; form.noValidate = true;
  const two = el("div", "fb__two"); two.id = "fb-city-row"; two.hidden = true;
  const field = (id, labelText, control) => { const f = el("label", "fb__field"); control.id = id; f.append(el("span", null, labelText), control); return f; };
  const city = el("input"); city.value = ""; city.maxLength = 80; city.autocomplete = "off"; city.placeholder = "City";
  const country = el("input"); country.value = ""; country.maxLength = 60; country.autocomplete = "country-name"; country.placeholder = "Country";
  two.append(field("fb-city", "City", city), field("fb-country", "Country", country));
  const msg = el("textarea"); msg.value = ""; msg.maxLength = MAX; msg.rows = 4; msg.setAttribute("aria-describedby", "fb-count");
  const msgField = field("fb-msg", "Message", msg);
  const count = el("p", "fb__count"); count.id = "fb-count";
  const left = el("span", null, String(MAX)); left.id = "fb-left";
  count.append(left, " characters left");
  const email = el("input"); email.setAttribute("type", "email"); email.value = ""; email.autocomplete = "email"; email.maxLength = 254; email.placeholder = "you@example.com";
  const emailField = field("fb-email", "E-mail for a reply (optional)", email);
  // the honeypot: not for people (hidden, out of the tab order, not read out); a bot that fills every field fills this one too
  const hp = el("input", "fb__hp"); hp.id = "fb-hp"; hp.setAttribute("name", "website"); hp.value = ""; hp.tabIndex = -1; hp.autocomplete = "off"; hp.setAttribute("aria-hidden", "true");
  const err = el("p", "fb__err"); err.id = "fb-err"; err.setAttribute("role", "alert"); err.hidden = true;
  const send = el("button", "btn btn--primary btn--block fb__send", "Send"); send.id = "fb-send"; send.type = "submit";
  const meta = el("p", "fb__meta"); meta.id = "fb-meta";
  form.append(two, msgField, count, emailField, hp, err, send, meta);

  const done = el("div", "fb__done"); done.id = "fb-done"; done.hidden = true;
  const doneMark = el("div", "fb__done-mark", "✓"); doneMark.setAttribute("aria-hidden", "true");
  const doneTitle = el("p", "fb__done-title", "Thanks, we read every message."); doneTitle.tabIndex = -1;
  const doneNote = el("p", null); doneNote.id = "fb-done-note";
  const again = el("button", "btn btn--glass btn--sm fb__again", "Send another"); again.id = "fb-again"; again.type = "button";
  done.append(doneMark, doneTitle, doneNote, again);

  panel.append(head, lead, kinds, form, done);
  root.append(panel, btn);
  document.body.append(root);

  /* ---------- state ---------- */
  let kind = "question", isOpen = false, sending = false, me = null;
  const setErr = (text) => { err.textContent = text || ""; err.hidden = !text; };
  const pagePath = () => { try { return location.pathname + location.search; } catch { return "/"; } };
  const whoLine = () => {
    const who = me && me.signedIn && me.user ? `signed in as ${me.user.handle ? "@" + me.user.handle.replace(/^@/, "") : "a member"}` : "not signed in";
    return `Sent with the page you're on (${pagePath()}) and your browser type, ${who}.`;
  };
  const refreshMeta = () => { meta.textContent = whoLine(); };
  if (V.ready && typeof V.ready.then === "function") V.ready.then((d) => { me = d; refreshMeta(); }).catch(() => {});
  refreshMeta();

  function select(next, { focus = false } = {}) {
    kind = next;
    const row = KINDS.find((k) => k[0] === kind);
    tabs.forEach((t) => { const on = t.dataset.kind === kind; t.setAttribute("aria-selected", on ? "true" : "false"); t.tabIndex = on ? 0 : -1; if (on && focus) t.focus(); });
    lead.textContent = row[2];
    msg.placeholder = row[3];
    two.hidden = kind !== "city";
    msg.required = kind !== "city";
    setErr("");
  }
  select("question");

  function open() {
    if (isOpen) return;
    isOpen = true;
    panel.hidden = false;
    btn.setAttribute("aria-expanded", "true"); btn.setAttribute("aria-label", "Close feedback");
    const current = tabs.find((t) => t.getAttribute("aria-selected") === "true") || tabs[0];
    (done.hidden ? current : doneTitle).focus({ preventScroll: true });
  }
  function close({ refocus = true } = {}) {
    if (!isOpen) return;
    isOpen = false;
    panel.hidden = true;
    btn.setAttribute("aria-expanded", "false"); btn.setAttribute("aria-label", "Feedback and support");
    if (refocus) btn.focus({ preventScroll: true });
  }
  const toggle = () => (isOpen ? close() : open());

  function reset() {
    form.hidden = false; kinds.hidden = false; lead.hidden = false; done.hidden = true;
    msg.value = ""; city.value = ""; country.value = ""; email.value = ""; hp.value = "";
    left.textContent = String(MAX);
    setErr("");
    select(kind, { focus: true });
  }

  async function submit(e) {
    e.preventDefault();
    if (sending) return;
    const message = msg.value.replace(/\s+$/, "");
    if (kind === "city") {
      if (city.value.trim().length < 2 || country.value.trim().length < 2) { setErr(ERRORS.bad_city); (city.value.trim().length < 2 ? city : country).focus(); return; }
    } else if (message.trim().length < 5) { setErr(ERRORS.bad_message); msg.focus(); return; }
    if (message.length > MAX) { setErr(`Please keep it under ${MAX} characters.`); msg.focus(); return; }
    const mail = email.value.trim();
    if (mail && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(mail)) { setErr(ERRORS.bad_email); email.focus(); return; }
    setErr("");
    sending = true; send.disabled = true; send.textContent = "Sending…";
    const body = { kind, message, page: pagePath(), website: hp.value || "" };
    if (mail) body.email = mail;
    if (kind === "city") { body.city = city.value.trim(); body.country = country.value.trim(); }
    const r = await api("/api/feedback", body);
    sending = false; send.disabled = false; send.textContent = "Send";
    if (!r || !r.ok) {
      const code = r && r.error;
      setErr(ERRORS[code] || (r && r._status === 0 ? ERRORS.offline : code === "wrong_origin" || code === "bad_kind" || code === "bad_json" ? "Couldn't send. Please reload the page and try again." : ERRORS.unavailable));
      return;
    }
    form.hidden = true; kinds.hidden = true; lead.hidden = true; done.hidden = false;
    doneNote.textContent = kind === "city" ? `We'll look at ${body.city} and get back to you${mail ? " at " + mail : " here on the map"}.`
      : mail ? `We'll reply to ${mail}.` : "Leave an e-mail next time if you'd like a reply.";
    doneTitle.focus({ preventScroll: true });
  }

  /* ---------- events ---------- */
  btn.addEventListener("click", toggle);
  closeBtn.addEventListener("click", () => close());
  again.addEventListener("click", reset);
  form.addEventListener("submit", submit);
  msg.addEventListener("input", () => { left.textContent = String(Math.max(0, MAX - msg.value.length)); });
  tabs.forEach((t) => t.addEventListener("click", () => select(t.dataset.kind, { focus: true })));
  kinds.addEventListener("keydown", (e) => {
    const i = KINDS.findIndex((k) => k[0] === kind);
    const to = e.key === "ArrowRight" || e.key === "ArrowDown" ? (i + 1) % KINDS.length : e.key === "ArrowLeft" || e.key === "ArrowUp" ? (i + KINDS.length - 1) % KINDS.length
      : e.key === "Home" ? 0 : e.key === "End" ? KINDS.length - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    select(KINDS[to][0], { focus: true });
  });
  root.addEventListener("keydown", (e) => { if (e.key === "Escape" && isOpen) { e.preventDefault(); e.stopPropagation(); close(); } });
  // a tap or click anywhere else closes the panel without stealing the keyboard
  document.addEventListener("pointerdown", (e) => { if (isOpen && !root.contains(e.target)) close({ refocus: false }); });

  // the Terms gate (site.js) makes the rest of the page inert while it is open; this widget is added after the gate took its
  // list, so it keeps itself inert as long as the gate shows
  const gate = $("#termsgate");
  if (gate) {
    const follow = () => { root.inert = !gate.hidden; };
    follow();
    if (typeof MutationObserver === "function") new MutationObserver(follow).observe(gate, { attributes: true, attributeFilter: ["hidden"] });
  }

  V.feedback = { open, close, select, reset };
})();
