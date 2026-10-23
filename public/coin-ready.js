// The ready-made city coin (COIN_V2_READY=on; the server is src/coinready.js). dashboard.js fetches this file ONLY when /api/me carries
// coinV2Ready: true, so with the switch off the page never asks for it. Then window.VCoinReady.init(ctx) and render(me) after every
// /api/me and every coin answer:
//   the city's founder   the #coin-ready card: the coin already made from the Vicinity city list (the picture, the registered ticker, the
//                        coin name, city, region, country, the description), read-only, with ONE action, "Use this coin", which sends the
//                        content hash of the very version on screen (a wallet proof is asked for when needed). The picture is drawn on
//                        the server once, the first time this page asks for it (POST /api/coins/ready/art); a GET never draws.
//   anyone in a city     the #coin card shows the coin as a preview labelled "Preview, not launched", only when the server sends one: a
//                        city that has a founder and whose coin this is (src/coinready.js previewOf: never a launched coin, a city with a
//                        waiting LaunchLab contract, or a design that is not the chosen ready-made version). The founder's own page
//                        shows it only while nothing stands in the way (no gate), or for the chosen coin being or already approved.
// ctx.onState(answer) hears every answer (dashboard-v2.js words the Today strip and the Founder card from it). Every value is set with
// textContent (never markup from text); the picture is an <img> of the server's own /coin-meta/art/<sha>.png.
(() => {
  "use strict";
  const { $ } = window.V;
  const ERR = {
    coin_changed: "Your coin changed since this page loaded (the city list or the Vicinity design was updated). Check it again, then use it.",
    reprove: "Confirm it's you with your wallet, then try again.",
    slow_down: "Too many tries. Wait a little, then try again.",
    sign_in: "Sign in again, then try again.",
    offline: "You seem to be offline. Nothing changed. Try again in a minute.",
  };
  let ctx = null, seq = 0, last = null, drawingFor = null, busy = false, painted = [null, {}], shownFor = null;

  function styled() {
    if (Array.from(document.querySelectorAll('link[rel="stylesheet"]')).some((l) => /\/coin-ready\.css$/.test(l.getAttribute("href") || ""))) return;
    const l = document.createElement("link"); l.setAttribute("rel", "stylesheet"); l.setAttribute("href", "/coin-ready.css"); (document.head || document.body).append(l);
  }
  const text = (sel, t) => { const n = $(sel); if (n) n.textContent = t == null ? "" : String(t); return n; };
  const show = (sel, on) => { const n = $(sel); if (n) n.hidden = !on; return n; };
  const place = (c) => [c.name, c.region, c.countryName].filter(Boolean).join(" · ");
  const altOf = (ticker) => `$${ticker} coin: the Vicinity city coin design`;
  const errorText = (r, fallback) => (r && (ERR[r.error] || r.message)) || fallback;
  const told = (r) => { if (ctx && typeof ctx.onState === "function") ctx.onState(r); };

  /* ---------- the founder's card ---------- */
  function paintFounder(r) {
    const card = $("#coin-ready");
    const coin = r.coin, gate = r.gate, chosen = r.chosen;
    // a launched coin is shown as itself by the coin card and the launch card; this card stays only for one launched with this design
    if (gate && gate.code === "launched" && !(chosen && chosen.launched)) { card.hidden = true; return; }
    card.hidden = false;
    text("#cr-place", r.city ? place(r.city) : "");
    // an approval on chain that is not this coin's (another wallet's, or one built from an earlier design): THAT is what launches, so the
    // card shows no coin of its own, only why (src/coinready.js approved_other, approved_earlier)
    const notThis = Boolean(gate && ["approved_other", "approved_earlier"].includes(gate.code));
    for (const sel of [".coin-ready__body", ".coin-ready__src", "#cr-version"]) show(sel, !notThis);
    const img = $("#cr-art"), wait = $("#cr-art-wait");
    const art = chosen && chosen.launched ? chosen.art : coin && coin.art;
    if (art) {
      if (img.getAttribute("src") !== art) img.setAttribute("src", art);
      img.alt = altOf(coin ? coin.ticker : "");
      img.hidden = false; wait.hidden = true;
    } else {
      img.hidden = true; img.removeAttribute("src");
      wait.hidden = false;
      wait.textContent = !coin ? "No coin yet" : gate ? "Your coin's picture is made once you can use it." : "Drawing your coin…";
    }
    text("#cr-ticker", coin ? `$${coin.ticker}` : "$—");
    text("#cr-name", coin ? coin.name : "—");
    text("#cr-city", r.city ? r.city.name : "—");
    show("#cr-region-row", Boolean(r.city && r.city.region));
    text("#cr-region", r.city && r.city.region ? r.city.region : "");
    text("#cr-country", r.city ? r.city.countryName || r.city.country : "—");
    text("#cr-pair", coin ? coin.pair : "SOL");
    text("#cr-desc", coin ? coin.description : "—");
    text("#cr-version", coin && coin.version ? `Design version ${coin.version}` : "");
    // a review that waits is said by the review card under the coin (its status and what it pauses), not a third time here
    const reviewSays = Boolean(gate && gate.code === "request_pending" && r.review);
    const g = show("#cr-gate", Boolean(gate) && !reviewSays);
    g.textContent = gate && !reviewSays ? gate.message : "";
    const use = $("#cr-use"), st = $("#cr-state");
    let state = ["Ready to choose", "tag--gold"], note = "";
    if (chosen && chosen.launched) { state = ["Launched", "tag--ok"]; note = "Your coin launched with this design. Its picture and words are fixed for good."; }
    // the founder's own coin, approved on chain or being approved right now: it is theirs, said as that (the gate's words say the rest)
    else if (gate && r.inUse && ["approved", "held"].includes(gate.code)) state = [gate.code === "approved" ? "Approved" : "Your coin", "tag--ok"];
    else if (gate && gate.code === "request_pending") state = ["Pending review", "tag--warn"];
    else if (gate) state = ["Not available now", "tag--warn"];
    else if (r.inUse) {
      state = ["Your coin", "tag--ok"];
      // COIN_V2_BATCH (approvalRound): the owner approves ready coins in rounds; never a time
      note = r.approvalRound === true ? "This is your coin's design now. Its launch opens after the owner's next approval round; then you launch it from your Founder tab."
        : "This is your coin's design now. Next, Vicinity's owner approves it on the blockchain; then you launch it from your Founder tab.";
    }
    else if (chosen && chosen.current && !chosen.mine) note = "A former founder of this city chose this coin. Use it to make it yours: Vicinity's owner approves only the current founder's choice.";
    else if (chosen && chosen.current) note = "Vicinity's design or the city list changed since you chose your coin. This is the new version: use it to keep your coin up to date.";
    else if (chosen && chosen.mine) note = "Your coin's design was changed since you chose it. Use this coin to choose it again.";
    // a design row kept aside: "your earlier design" only when this founder's own account saved it (earlier); a former founder's is said as
    // that (earlierOther), never as theirs
    else if (r.earlier) note = "Your earlier coin design is kept, but it is not launched: city coins are made by Vicinity now. Use this coin to choose yours.";
    else if (r.earlierOther) note = "A former founder's coin design is kept, but it is not launched: city coins are made by Vicinity now. Use this coin to choose yours.";
    st.textContent = state[0]; st.className = `tag ${state[1]}`;
    text("#cr-note", note);
    const usable = Boolean(coin && coin.contentHash && !gate && !r.inUse && !(chosen && chosen.launched));
    use.hidden = Boolean(r.inUse || (chosen && chosen.launched));
    // while saving the button keeps the keyboard (aria-disabled, clicks ignored): a disabled button would drop focus to the page
    use.disabled = !usable && !busy;
    if (busy) use.setAttribute("aria-disabled", "true"); else use.removeAttribute("aria-disabled");
    use.textContent = busy ? "Saving…" : "Use this coin";
    use.setAttribute("aria-label", busy ? "Saving your choice…" : coin ? `Use this coin: $${coin.ticker}, ${coin.name}` : "Use this coin");
  }

  /* ---------- the coin card's preview ---------- */
  // mine: the founder's page only; the chosen coin was chosen with THEIR seat (the server's preview.chosen is true for the city's current
  // choice whoever made it: after a seat change, a former founder's)
  function paintPreview(p, { founder = false, approved = false, mine = false } = {}) {
    const box = $("#coin-preview"), coinCard = $("#coin"), kick = $("#coin-kicker");
    painted = [p, { founder, approved, mine }]; // repaint() puts it back after dashboard.js draws the coin card again
    if (!box || !coinCard) return;
    // the card's eyebrow says who made what it shows: dashboard.js keeps its own words in data-base (the founder's design as before),
    // and Vicinity's coin is named while the preview stands in
    if (!p) { box.hidden = true; coinCard.classList.remove("has-preview"); if (kick && kick.dataset.base) kick.textContent = kick.dataset.base; return; }
    box.hidden = false; coinCard.classList.add("has-preview");
    if (kick) kick.textContent = "City coin · made by Vicinity";
    const img = $("#coin-preview-art");
    if (p.art) { if (img.getAttribute("src") !== p.art) img.setAttribute("src", p.art); img.alt = altOf(p.ticker); img.hidden = false; }
    else { img.hidden = true; img.removeAttribute("src"); }
    text("#coin-preview-tag", p.label || "Preview, not launched");
    text("#coin-preview-ticker", `$${p.ticker}`);
    text("#coin-preview-name", [p.name, p.city && p.city.region, p.city && p.city.countryName].filter(Boolean).join(" · "));
    text("#coin-preview-note", founder
      ? (approved ? "This is your city coin, approved on the blockchain. It has not launched yet."
        : p.chosen && mine ? "This is the coin you chose. Nothing has launched yet."
          : p.chosen ? "A former founder of this city chose this coin: use it in your Founder tab to make it yours. Nothing has launched yet."
            : `This is what $${p.ticker} will look like. You choose it in your Founder tab; nothing has launched yet.`)
      : p.chosen ? `This is the coin chosen for ${p.name}: made by Vicinity from the city list. Nothing has launched yet.`
        : `This is what $${p.ticker} will look like once ${p.name}'s founder launches it. Made by Vicinity from the city list; nothing has launched yet.`);
    const st = $("#coin-status");
    if (st) { st.textContent = "Not launched"; st.className = "tag tag--warn"; }
    text("#coin-note", "");
  }
  /** How the founder's page words the preview: approved for them on chain, and whether the chosen coin is their own choice (mine). */
  const founderOpts = (r) => ({ founder: true, approved: Boolean(r.gate && r.gate.code === "approved"), mine: Boolean(r.chosen && r.chosen.mine) });
  /**
   * The founder's preview: the server's (src/coinready.js previewOf), only while nothing stands in the way, or for the CHOSEN coin
   * being or already approved (gates held and approved: that coin is what launches). Any other gate (a waiting contract, a launched
   * coin, a ticker taken elsewhere, a seat in grace...) leaves the coin card as it was.
   */
  function founderPreview(r) {
    const p = r.preview || null;
    if (!p) return null;
    if (!r.gate) return p;
    return ["approved", "held"].includes(r.gate.code) && p.chosen ? p : null;
  }

  /* ---------- the review step (COIN_V2_REVIEW=on: the server's founder answer carries `review`) ---------- */
  // public/coin-review.js adds Request changes, the review status and the founder's own description to this card. It is fetched ONLY when
  // an answer carries `review`, so with the switch off this page never asks for it. Every answer of its routes is a founder answer again:
  // the card is painted from it as from any other.
  let review = null, reviewAsked = false;
  function withReview(r) {
    if (!r || !r.review) { if (review) review.hide(); return; }
    if (review) { review.paint(r); return; }
    if (reviewAsked) return;
    reviewAsked = true;
    const s = document.createElement("script"); s.src = "/coin-review.js";
    s.onload = () => {
      if (!window.VCoinReview) { reviewAsked = false; return; }
      review = window.VCoinReview.init({ api: ctx.api, sensitive: ctx.sensitive, toast: ctx.toast, answer: reviewAnswer });
      if (last && last.review) review.paint(last);
    };
    s.onerror = () => { reviewAsked = false; };
    (document.head || document.body).append(s);
  }
  /** An answer of a review route (a founder answer): the whole card follows it, and the coin card and the launch card read again. */
  function reviewAnswer(r) {
    if (!r || r.mode !== "founder") return;
    last = r;
    paintFounder(r);
    paintPreview(founderPreview(r), founderOpts(r));
    withReview(r);
    told(r);
    if (ctx.changed) ctx.changed();
  }

  /* ---------- reading, drawing, using ---------- */
  async function render(me) {
    const c = me && me.community;
    const my = ++seq;
    if (!c) { shownFor = null; show("#coin-ready", false); paintPreview(null); withReview(null); told(null); return; }
    if (shownFor !== c.id) { if (shownFor) paintPreview(null); shownFor = c.id; } // another city: never its predecessor's preview meanwhile
    const r = await ctx.api(`/api/coins/ready?city=${encodeURIComponent(c.id)}`);
    if (my !== seq) return; // a newer render is on its way
    if (!r || r.ok === false) { show("#coin-ready", false); paintPreview(null); withReview(null); told(null); return; } // off (404) or unreadable: the page as before
    last = r;
    if (r.mode === "founder") {
      paintFounder(r);
      paintPreview(founderPreview(r), founderOpts(r));
      withReview(r);
      if (r.coin && !r.coin.art && !r.gate) draw(c.id);
    } else {
      show("#coin-ready", false);
      paintPreview(r.preview);
      withReview(null);
    }
    told(r);
  }
  /** The founder's picture, drawn once on the server (never again: the next answer carries it). */
  async function draw(cityId) {
    if (drawingFor === cityId) return;
    drawingFor = cityId;
    const r = await ctx.api("/api/coins/ready/art", { cityId });
    if (r && r.ok && r.mode === "founder") { last = r; paintFounder(r); paintPreview(founderPreview(r), founderOpts(r)); withReview(r); told(r); return; }
    text("#cr-art-wait", "Your coin's picture couldn't be made just now. Reload the page to try again.");
    drawingFor = null;
  }
  async function onUse() {
    const r0 = last, use = $("#cr-use");
    if (busy || use.getAttribute("aria-disabled") === "true" || !r0 || !r0.coin || !r0.coin.contentHash) return;
    busy = true; show("#cr-err", false); paintFounder(r0);
    let r;
    try { r = await ctx.sensitive(() => ctx.api("/api/coins/ready/use", { cityId: r0.city.id, contentHash: r0.coin.contentHash })); }
    finally { busy = false; }
    if (r && r.ok) {
      last = r;
      // the keyboard goes to the card's state ("Your coin") before the button goes away, never back to the top of the page
      const st = $("#cr-state");
      if (st) st.focus();
      paintFounder(r);
      paintPreview(founderPreview(r), founderOpts(r));
      withReview(r);
      told(r);
      ctx.toast(`$${r.coin.ticker} is your coin`);
      if (ctx.changed) ctx.changed(); // the coin card and the launch card read the new design
      return;
    }
    if (r && r.error === "coin_changed" && r.coin) { last = r; paintFounder(r); told(r); }
    else paintFounder(r0);
    const e = text("#cr-err", errorText(r, "Couldn't use this coin just now. Nothing changed. Try again in a minute."));
    e.hidden = false;
    if (!use.hidden && !use.disabled) use.focus(); // a refusal keeps the keyboard on the action, next to its words
  }

  window.VCoinReady = {
    init(c) {
      ctx = c;
      styled();
      $("#cr-use").addEventListener("click", onUse);
      // repaint: dashboard.js draws the coin card again (the launchpad's answer, a saved design) after the preview was painted;
      // the preview's status, note and eyebrow go back over the card's own words (nothing is asked again)
      return { render, state: () => last, repaint: () => paintPreview(...painted) };
    },
  };
})();
