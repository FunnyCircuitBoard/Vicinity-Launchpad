// Request changes, the review status and the founder's own description (COIN_V2_REVIEW=on; the server is src/coinreview.js). public/coin-ready.js
// fetches this file ONLY when the founder's answer carries `review`, then calls window.VCoinReview.init(ctx) once and paint(answer) after every
// answer. It adds to the founder's #coin-ready card, under the read-only coin:
//   the launch hold        what pauses the launch now, in the server's words (a request waiting for review, a ticker waiting for the city list...)
//   the request card       Draft / Pending / Approved / Changes needed, with the server's sentence, the reviewer's reason and note, and what
//                          the request changes (now and proposed side by side); Cancel request, Edit, Revise, Request other changes
//   Request changes        a separate, private draft: another picture (the Vicinity design, or the founder's own upload, shrunk in the browser
//                          like the studio's), another ticker (checked as it is typed) or name, and a "why" only reviewers read. Save draft;
//                          Submit for review asks first ("Submitting pauses your launch until a reviewer decides"); Discard draft
//   Write your own         the description, checked by the server: a pass is used at once; a flag offers Revise, Send for review and Keep the
//                          default; a block offers Revise; an error says nothing changed. The flagged words are marked in the text
// Every value is set with textContent (never markup from text); pictures are <img> of the server's own URLs. Nothing here decides anything:
// the server checks it all again.
(() => {
  "use strict";
  const { $ } = window.V;
  const ERR = {
    reprove: "Confirm it's you with your wallet, then try again.",
    slow_down: "Too many tries. Wait a little, then try again.",
    sign_in: "Sign in again, then try again.",
    offline: "You seem to be offline. Nothing changed. Try again in a minute.",
  };
  const FIELD = { picture: "Picture", ticker: "Ticker", name: "Coin name", description: "Description" };
  const TAG = { draft: "crv-tag--draft", pending: "crv-tag--pending", approved: "crv-tag--ok", changes_needed: "crv-tag--changes" };
  let ctx = null, last = null, busy = false;
  let formOpen = false, formDirty = false, confirmOpen = false, describeOpen = false;
  const draft = { name: "", symbol: "", picture: "vicinity", image: null, imageUrl: null, reason: "", updatedAt: null };
  let screening = null; // the last check's result shown under the editor ({ id, result, text, issues })
  let captionWas = null;

  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = String(text); return n; };
  const button = (label, onClick, cls = "btn btn--glass") => {
    const b = el("button", cls, label); b.type = "button";
    b.addEventListener("click", () => { if (!busy) onClick(b); });
    return b;
  };
  const errorText = (r, fallback) => (r && (ERR[r.error] || r.message)) || fallback;
  // UTF-8 bytes, as the blockchain counts a name (32 at most; accents count 2)
  const bytes = (s) => { try { return unescape(encodeURIComponent(s || "")).length; } catch { return Infinity; } };

  function styled() {
    if (Array.from(document.querySelectorAll('link[rel="stylesheet"]')).some((l) => /\/coin-review\.css$/.test(l.getAttribute("href") || ""))) return;
    const l = document.createElement("link"); l.setAttribute("rel", "stylesheet"); l.setAttribute("href", "/coin-review.css"); (document.head || document.body).append(l);
  }
  /** The card's parts, made once (later paints fill them, so a form being typed in keeps its keyboard). */
  function parts() {
    const card = $("#coin-ready");
    let root = document.getElementById("crv");
    if (!root) {
      root = el("div", "coin-review"); root.id = "crv";
      const hold = el("p", "small crv-hold"); hold.id = "crv-hold"; hold.setAttribute("role", "status"); hold.hidden = true;
      const status = el("div", "crv-status"); status.id = "crv-status"; status.setAttribute("aria-live", "polite");
      const actions = el("div", "crv-actions"); actions.id = "crv-actions";
      const form = el("div", "crv-form"); form.id = "crv-form"; form.hidden = true;
      const desc = el("div", "crv-desc"); desc.id = "crv-desc"; desc.setAttribute("aria-live", "polite");
      const err = el("p", "wallet__error crv-err"); err.id = "crv-err"; err.setAttribute("role", "alert"); err.hidden = true;
      root.append(hold, status, actions, form, desc, err);
      card.append(root);
    }
    return { root, hold: $("#crv-hold"), status: $("#crv-status"), actions: $("#crv-actions"), form: $("#crv-form"), desc: $("#crv-desc"), err: $("#crv-err") };
  }
  function say(msg) { const e = $("#crv-err"); if (!e) return; e.textContent = msg || ""; e.hidden = !msg; }

  /* ---------- talking to the server ---------- */
  async function send(path, body, okWords) {
    if (busy) return null;
    busy = true; say("");
    let r;
    try { r = await ctx.sensitive(() => ctx.api(`/api/coins/review/${path}`, { cityId: last.city.id, ...body })); }
    catch { r = { ok: false, error: "offline" }; }
    finally { busy = false; }
    if (r && r.mode === "founder") ctx.answer(r); // the whole card follows the answer (src/coinreview.js answers the founder's view)
    if (r && r.ok) { if (okWords) ctx.toast(okWords); return r; }
    say(errorText(r, "That didn't work just now. Nothing changed. Try again in a minute."));
    return r || null;
  }

  /* ---------- painting ---------- */
  function paint(r) {
    last = r;
    const R = r && r.review;
    if (!R) { hide(); return; }
    const p = parts();
    p.root.hidden = false;
    caption(true);
    // what holds the launch now
    p.hold.hidden = !R.hold;
    p.hold.textContent = R.hold ? R.hold.message : "";
    paintStatus(p.status, R);
    paintActions(p.actions, R);
    const req = R.request;
    if (req && req.status === "draft" && !formDirty) fromDraft(req.draft);
    if (req && req.status === "draft") formOpen = true;
    if (req && req.status === "pending") { formOpen = false; formDirty = false; confirmOpen = false; }
    paintForm(p.form, R);
    paintDescription(p.desc, R);
  }
  function hide() {
    const root = document.getElementById("crv");
    if (root) root.hidden = true;
    caption(false);
  }
  /** The card's caption says how changes happen now (put back as it was when the step is hidden). */
  function caption(on) {
    const c = document.querySelector(".coin-ready__caption");
    if (!c) return;
    const words = "Set by Vicinity. Every city coin uses the same Vicinity design, filled in from the Vicinity city list. You can't edit these yourself: request changes and a reviewer decides.";
    const node = Array.from(c.childNodes || []).filter((n) => n && !n.tagName && typeof n.textContent === "string" && n.textContent.trim()).pop() || null; // the words after the icon
    // (a text node's words are its `data`)
    if (on) {
      if (captionWas == null) captionWas = node ? node.data : c.textContent;
      if (node) node.data = words; else c.textContent = words;
    } else if (captionWas != null) {
      if (node) node.data = captionWas; else c.textContent = captionWas;
      captionWas = null;
    }
  }

  function picture(src, alt) {
    if (!src) return el("span", "muted", "—");
    const i = el("img", "crv-pic"); i.setAttribute("src", src); i.alt = alt; i.width = 56; i.height = 56; return i;
  }
  /** What a request changes: field, now, proposed (pictures side by side). */
  function diffTable(diff) {
    const t = el("table", "crv-diff");
    const head = el("tr"); for (const h of ["", "Now", "Proposed"]) { const th = el("th", null, h); th.setAttribute("scope", "col"); head.append(th); }
    const thead = el("thead"); thead.append(head); t.append(thead);
    const body = el("tbody");
    for (const d of diff || []) {
      const tr = el("tr");
      const th = el("th", null, FIELD[d.field] || d.field); th.setAttribute("scope", "row"); tr.append(th);
      for (const [v, which] of [[d.from, "now"], [d.to, "proposed"]]) {
        const td = el("td");
        if (d.field === "picture") td.append(picture(v, which === "now" ? "The coin's picture now" : "The proposed picture"));
        else td.textContent = v == null ? "—" : String(v);
        tr.append(td);
      }
      body.append(tr);
    }
    t.append(body);
    return t;
  }
  function paintStatus(box, R) {
    const req = R.request;
    box.replaceChildren();
    if (!req || req.status === "draft") return;
    const card = el("section", `crv-card crv-card--${req.status}`); card.setAttribute("aria-labelledby", "crv-req-title");
    const head = el("div", "crv-card__head");
    const title = el("h3", "h3--sm", req.kind === "description" ? "Description review" : "Change request"); title.id = "crv-req-title";
    const tag = el("span", `tag crv-tag ${TAG[req.status] || ""}`, req.label); tag.id = "crv-req-tag";
    head.append(title, tag);
    const msg = el("p", "small crv-card__msg", req.message); msg.id = "crv-req-msg";
    card.append(head, msg);
    if (req.submittedAt && req.status === "pending") card.append(el("p", "tiny muted", `Sent ${when(req.submittedAt)} · version ${req.version}`));
    if (req.diff && req.diff.length) card.append(diffTable(req.diff));
    const row = el("div", "crv-row");
    if (req.status === "pending") {
      row.append(button("Cancel request", () => send("cancel", { requestId: req.id }, "Request cancelled: your approved coin is back")));
      if (req.kind === "change" && R.can.edit) {
        row.append(button("Edit", () => {
          if (!window.confirm("Editing withdraws this version; the new version needs its own review. Edit it?")) return;
          formDirty = false;
          send("edit", { requestId: req.id }, "Back to a draft");
        }));
      }
    } else if (req.status === "changes_needed") {
      if (req.kind === "change" && R.can.edit) row.append(button("Revise", () => { formDirty = false; send("edit", { requestId: req.id }, "A new draft, from your last version"); }, "btn btn--primary"));
      else if (req.kind === "description") row.append(button("Revise", () => openDescribe(req.proposed && req.proposed.description)));
      row.append(button("Cancel and keep the approved coin", () => send("cancel", { requestId: req.id })));
    } else if (req.status === "approved") {
      if (R.can.request) row.append(button("Request other changes", () => openForm()));
    }
    if (row.childNodes.length) card.append(row);
    box.append(card);
  }
  const when = (iso) => { try { return new Date(iso).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); } catch { return iso; } };

  function paintActions(box, R) {
    box.replaceChildren();
    if (R.blocked) { box.append(el("p", "small muted crv-blocked", R.blocked)); return; }
    const open = R.request && ["draft", "pending"].includes(R.request.status);
    if (R.can.request && !open && !formOpen) box.append(button("Request changes", () => openForm()));
    if (R.can.describe && !describeOpen) box.append(button("Write your own description", () => openDescribe()));
    if (R.can.reset) {
      box.append(button("Reset to Vicinity defaults", () => {
        if (!window.confirm("Go back to the Vicinity coin as the city list makes it (its picture, ticker, name and description)?")) return;
        send("reset", {}, "Back to the Vicinity coin");
      }));
    }
  }

  /* ---------- the draft ---------- */
  function fromDraft(d) {
    if (!d) return;
    draft.name = d.name || ""; draft.symbol = d.symbol || ""; draft.picture = d.picture || "vicinity"; draft.reason = d.reason || "";
    draft.updatedAt = d.updatedAt || null; draft.imageUrl = d.art || null; draft.image = null;
  }
  function openForm() {
    formOpen = true; formDirty = false;
    const req = last.review.request;
    if (req && req.status === "draft") fromDraft(req.draft);
    else Object.assign(draft, { name: "", symbol: "", picture: "vicinity", image: null, imageUrl: null, reason: "", updatedAt: null });
    paint(last);
    const f = $("#crv-name");
    if (f) f.focus();
  }
  function paintForm(box, R) {
    if (!formOpen) { box.hidden = true; box.replaceChildren(); return; }
    box.hidden = false;
    if (box.dataset.built === "1" && box.querySelector("#crv-name")) { syncForm(R); return; } // typed values stay; only the server's parts follow
    box.dataset.built = "1";
    box.replaceChildren();
    const sel = R.selected || {}, defs = R.defaults || {};
    const title = el("h3", "h3--sm", "Change request · draft"); title.id = "crv-form-title";
    const intro = el("p", "small", "Your draft is private. Your coin stays as it is until a reviewer approves the change. Submitting pauses your launch until they decide.");
    // the picture
    const pics = el("fieldset", "crv-fieldset"); pics.append(el("legend", null, "Picture"));
    const choices = [["vicinity", "Keep the Vicinity design (drawn with your ticker and name)"], ...(sel.upload ? [["keep", "Keep this picture"]] : []), ["upload", "Upload a picture"]];
    for (const [v, label] of choices) {
      const l = el("label", "crv-choice"); const i = el("input"); i.setAttribute("type", "radio"); i.setAttribute("name", "crv-picture"); i.value = v; i.setAttribute("value", v); i.id = `crv-pic-${v}`;
      i.checked = draft.picture === v;
      i.addEventListener("change", () => { draft.picture = v; formDirty = true; syncForm(last.review); });
      l.append(i, el("span", null, label)); pics.append(l);
    }
    const file = el("input"); file.setAttribute("type", "file"); file.id = "crv-file"; file.setAttribute("accept", "image/png,image/jpeg,image/webp"); file.setAttribute("aria-label", "Choose a picture");
    file.addEventListener("change", () => readPicture(file));
    const prev = el("img", "crv-pic crv-pic--lg"); prev.id = "crv-preview"; prev.alt = "Your proposed picture"; prev.hidden = true;
    pics.append(file, prev, el("p", "tiny muted", "A person checks every picture. Logos or photos you don't own can't be used."));
    // the ticker
    const tk = el("input"); tk.id = "crv-symbol"; tk.setAttribute("maxlength", "10"); tk.setAttribute("autocapitalize", "characters"); tk.setAttribute("spellcheck", "false");
    tk.placeholder = sel.symbol || defs.symbol || ""; tk.value = draft.symbol;
    tk.addEventListener("input", () => { tk.value = tk.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10); draft.symbol = tk.value; formDirty = true; $("#crv-symbol-msg").textContent = ""; });
    tk.addEventListener("change", () => checkTicker());
    const tkMsg = el("p", "tiny crv-symbol-msg"); tkMsg.id = "crv-symbol-msg"; tkMsg.setAttribute("aria-live", "polite");
    // the name
    const nm = el("input"); nm.id = "crv-name"; nm.setAttribute("maxlength", "64"); nm.placeholder = sel.name || defs.name || ""; nm.value = draft.name;
    const nmCount = el("p", "tiny muted"); nmCount.id = "crv-name-count";
    nm.addEventListener("input", () => { draft.name = nm.value; formDirty = true; countName(); });
    // the why
    const why = el("textarea"); why.id = "crv-reason"; why.setAttribute("maxlength", "300"); why.rows = 3; why.value = draft.reason;
    why.placeholder = "Tell the reviewer why. For example: 'Locals call it UticaNY'.";
    why.addEventListener("input", () => { draft.reason = why.value; formDirty = true; });
    const label = (text, input, help) => { const l = el("label", "crv-field"); l.append(el("span", "fieldset__label", text), input); if (help) l.append(help); return l; };
    // the buttons, and the question before submitting
    const save = button("Save draft", () => saveDraft());
    const submit = button("Submit for review", () => askSubmit(), "btn btn--primary"); submit.id = "crv-submit";
    const discard = button("Discard draft", () => discardDraft());
    const row = el("div", "crv-row"); row.append(submit, save, discard);
    const ask = el("div", "crv-confirm"); ask.id = "crv-confirm"; ask.hidden = true; ask.setAttribute("role", "group"); ask.setAttribute("aria-labelledby", "crv-confirm-title");
    box.append(title, intro, pics,
      label("Ticker", tk, el("p", "tiny muted", "Tickers come from the Vicinity city list. An approved change is added to the list in a site update before you can launch with it.")), tkMsg,
      label("Coin name", nm, nmCount), label("Why (only the reviewers read this)", why), row, ask);
    syncForm(R);
  }
  /** The parts of the form the server or the choice decide: the preview, the file input, the counter, the question. */
  function syncForm(R) {
    const prev = $("#crv-preview"), file = $("#crv-file");
    if (!prev) return;
    const sel = R.selected || {};
    const src = draft.picture === "upload" ? (draft.image ? `data:${draft.image.type};base64,${draft.image.b64}` : draft.imageUrl) : draft.picture === "keep" ? sel.art : draft.imageUrl && !formDirty ? draft.imageUrl : null;
    prev.hidden = !src;
    if (src) prev.setAttribute("src", src); else prev.removeAttribute("src");
    file.hidden = draft.picture !== "upload";
    for (const v of ["vicinity", "keep", "upload"]) { const i = $(`#crv-pic-${v}`); if (i) i.checked = draft.picture === v; }
    countName();
    paintConfirm(R);
  }
  function countName() {
    const c = $("#crv-name-count"); if (!c) return;
    const n = bytes(draft.name);
    c.textContent = draft.name ? `${n} of 32 bytes (accents count 2)` : "Leave it empty to keep your coin's name.";
    c.classList.toggle("crv-over", n > 32);
  }
  async function readPicture(input) {
    const file = input.files && input.files[0]; if (!file) return;
    try {
      const url = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
      // cropped to a centred square and shrunk under 190 KB, as the studio did (src/social.js readImage takes WebP, PNG or JPEG)
      const side = Math.min(img.width, img.height);
      let size = 512, out = "";
      for (let k = 0; k < 5; k++) {
        const cv = document.createElement("canvas"); cv.width = cv.height = size;
        cv.getContext("2d").drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
        out = cv.toDataURL("image/webp", 0.86);
        if (!out.startsWith("data:image/webp")) out = cv.toDataURL("image/png");
        if (out.length * 0.75 < 190_000) break;
        size = Math.round(size * 0.8);
      }
      draft.image = { type: out.slice(5, out.indexOf(";")), b64: out.slice(out.indexOf(",") + 1) };
      draft.picture = "upload"; formDirty = true;
      syncForm(last.review);
    } catch { say("That picture couldn't be read. Use a PNG, JPEG or WebP."); }
    input.value = "";
  }
  async function checkTicker() {
    const t = draft.symbol, msg = $("#crv-symbol-msg");
    if (!t || !msg) return;
    let r;
    try { r = await ctx.api(`/api/coins/review/ticker-check?city=${encodeURIComponent(last.city.id)}&t=${encodeURIComponent(t)}`); } catch { r = null; }
    if (draft.symbol !== t) return; // typed on meanwhile
    msg.textContent = r && r.ok ? r.message : "The ticker couldn't be checked just now. The reviewer checks it anyway.";
    msg.classList.toggle("crv-bad", Boolean(r && r.ok && !r.available));
  }
  const draftBody = () => ({ name: draft.name.trim() || null, symbol: draft.symbol || null, picture: draft.picture, reason: draft.reason,
    ...(draft.picture === "upload" && draft.image ? { image: draft.image.b64 } : {}), ...(draft.updatedAt ? { draftUpdatedAt: draft.updatedAt } : {}) });
  async function saveDraft() {
    const r = await send("draft", draftBody(), "Draft saved");
    if (r && r.ok) { formDirty = false; draft.image = null; fromDraft(r.review.request && r.review.request.draft); paint(r); }
    return r;
  }
  async function askSubmit() {
    if (formDirty || !draft.updatedAt) { const r = await saveDraft(); if (!r || !r.ok) return; }
    confirmOpen = true;
    paintConfirm(last.review);
    const go = $("#crv-confirm-go"); if (go) go.focus();
  }
  function paintConfirm(R) {
    const box = $("#crv-confirm");
    if (!box) return;
    box.hidden = !confirmOpen;
    box.replaceChildren();
    if (!confirmOpen) return;
    const req = R.request;
    const t = el("p", "small crv-confirm__title", "Submit this change for review?"); t.id = "crv-confirm-title";
    box.append(t);
    if (req && req.diff && req.diff.length) box.append(diffTable(req.diff));
    box.append(el("p", "small", "Submitting pauses your launch until a reviewer decides."));
    const go = button("Submit", async () => {
      confirmOpen = false;
      const r = await send("submit", { draftUpdatedAt: draft.updatedAt }, "Sent for review");
      if (r && r.ok) {
        formOpen = false; formDirty = false;
        const s = $("#crv-req-tag"); // the keyboard goes to the new status ("Pending"), never back to the top of the page
        if (s) { s.setAttribute("tabindex", "-1"); s.focus(); }
      }
      else paint(last);
    }, "btn btn--primary"); go.id = "crv-confirm-go";
    const back = button("Back", () => { confirmOpen = false; paint(last); const s = $("#crv-submit"); if (s) s.focus(); });
    const row = el("div", "crv-row"); row.append(go, back); box.append(row);
  }
  async function discardDraft() {
    const req = last.review.request;
    if (req && req.status === "draft") { const r = await send("cancel", { requestId: req.id }, "Draft discarded"); if (!r || !r.ok) return; }
    formOpen = false; formDirty = false; confirmOpen = false;
    const box = $("#crv-form"); if (box) { box.dataset.built = ""; box.replaceChildren(); }
    paint(last);
  }

  /* ---------- the description ---------- */
  function openDescribe(text) {
    describeOpen = true; screening = null;
    paint(last);
    const t = $("#crv-desc-text");
    if (t) { if (text != null) t.value = text; t.focus(); counter(); }
  }
  function counter() {
    const t = $("#crv-desc-text"), c = $("#crv-desc-count");
    if (t && c) { const n = Array.from(t.value).length; c.textContent = `${n} of 200 characters`; c.classList.toggle("crv-over", n > 200 || (n > 0 && n < 10)); }
  }
  function paintDescription(box, R) {
    const d = R.description || {};
    const shown = screening || (d.screening && !describeOpen ? d.screening : null);
    let editor = $("#crv-desc-editor");
    if (!describeOpen && editor) { editor.remove(); editor = null; }
    let info = $("#crv-desc-info");
    if (!info) { info = el("p", "small crv-desc-info"); info.id = "crv-desc-info"; box.prepend(info); }
    info.textContent = d.source === "founder" ? "Description: your own, checked by Vicinity." : "Description: Vicinity's default.";
    if (describeOpen && !editor) {
      editor = el("div", "crv-editor"); editor.id = "crv-desc-editor";
      const city = (last.city && last.city.name) || "your city";
      const ta = el("textarea"); ta.id = "crv-desc-text"; ta.rows = 3; ta.setAttribute("maxlength", "400");
      ta.placeholder = `What makes ${city} worth a coin? No links, prices or promises.`;
      ta.value = d.source === "founder" ? d.text || "" : "";
      ta.addEventListener("input", counter);
      const lab = el("label", "crv-field"); lab.append(el("span", "fieldset__label", "Your description"), ta);
      const count = el("p", "tiny muted"); count.id = "crv-desc-count";
      const check = button("Check description", () => checkDescription(), "btn btn--primary"); check.id = "crv-desc-check";
      const close = button("Close", () => { describeOpen = false; screening = null; paint(last); });
      const row = el("div", "crv-row"); row.append(check, close);
      editor.append(lab, count, row);
      box.append(editor);
      counter();
    }
    let res = $("#crv-desc-result");
    if (!res) { res = el("div", "crv-result"); res.id = "crv-desc-result"; box.append(res); }
    paintResult(res, shown, R);
  }
  async function checkDescription() {
    const ta = $("#crv-desc-text"); if (!ta) return;
    const r = await send("description", { text: ta.value });
    if (r && r.ok && r.screening) {
      screening = r.screening;
      if (r.screening.result === "pass") { describeOpen = false; ctx.toast("Description checked: your coin uses it now"); }
      paint(last);
      const res = $("#crv-desc-result"); if (res && res.firstChild && res.firstChild.focus) res.firstChild.focus();
    } else if (r && r.error === "screening_error") {
      screening = { result: "error", text: ta.value, issues: [] };
      paint(last);
    }
  }
  /** The checked text with each flagged span marked (<mark>, text only). */
  function marked(text, issues) {
    const p = el("p", "crv-quote");
    const spans = (issues || []).filter((x) => Number.isInteger(x.start) && Number.isInteger(x.end) && x.end > x.start).sort((a, b) => a.start - b.start);
    let at = 0;
    for (const x of spans) {
      if (x.start < at) continue;
      if (x.start > at) p.append(el("span", null, text.slice(at, x.start)));
      const m = el("mark", null, text.slice(x.start, x.end)); m.title = x.message || ""; p.append(m);
      at = x.end;
    }
    if (at < text.length) p.append(el("span", null, text.slice(at)));
    return p;
  }
  function paintResult(box, s, R) {
    box.replaceChildren();
    if (!s) return;
    const card = el("section", `crv-card crv-card--${s.result}`); card.setAttribute("tabindex", "-1");
    const sentences = [...new Set((s.issues || []).map((x) => x.message))];
    const words = {
      pass: "Looks good. Your coin uses this description now.",
      block: "This can't be used:",
      flag: "This needs a person to look at it:",
      error: "We couldn't check your description just now. Nothing changed: your coin keeps its current description. Try again in a minute.",
    };
    const head = el("p", "small crv-result__head", words[s.result] || words.error); head.id = "crv-desc-verdict";
    card.append(head);
    if (sentences.length) { const ul = el("ul", "small crv-issues"); for (const t of sentences) ul.append(el("li", null, t)); card.append(ul); }
    if (s.text && s.result !== "pass") card.append(marked(s.text, s.issues));
    const row = el("div", "crv-row");
    if (s.result === "flag") {
      card.append(el("p", "small", "You can revise it, or send it to Vicinity for review; your launch waits until they decide. Or keep the default description and launch now."));
      row.append(button("Revise", () => openDescribe(s.text)));
      if (s.id) row.append(button("Send for review", () => send("description/review", { screeningId: s.id }, "Sent for review").then((r) => { if (r && r.ok) { screening = null; describeOpen = false; paint(last); } }), "btn btn--primary"));
      row.append(button("Keep the default", () => send("description/default", {}, "Default description").then((r) => { if (r && r.ok) { screening = null; describeOpen = false; paint(last); } })));
    } else if (s.result === "block") row.append(button("Revise", () => openDescribe(s.text)));
    else if (s.result === "error") row.append(button("Try again", () => checkDescription()));
    else if (s.result === "pass" && R.description && R.description.source === "founder") {
      row.append(button("Use the default instead", () => send("description/default", {}, "Default description").then((r) => { if (r && r.ok) { screening = null; paint(last); } })));
    }
    if (row.childNodes.length) card.append(row);
    box.append(card);
  }

  window.VCoinReview = {
    init(c) {
      ctx = c;
      styled();
      return { paint, hide };
    },
  };
})();
