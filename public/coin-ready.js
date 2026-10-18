// The ready-made city coin (COIN_V2_READY=on; the server is src/coinready.js). dashboard.js fetches this file ONLY when /api/me carries
// coinV2Ready: true, so with the switch off the page never asks for it. Then window.VCoinReady.init(ctx) and render(me) after every
// /api/me and every coin answer:
//   the city's founder   the #coin-ready card: the coin already made from the Vicinity city list (the picture, the registered ticker, the
//                        coin name, city, region, country, the description), read-only, with ONE action, "Use this coin", which sends the
//                        content hash of the very version on screen (a wallet proof is asked for when needed). The picture is drawn on
//                        the server once, the first time this page asks for it (POST /api/coins/ready/art); a GET never draws.
//   anyone in a city     the #coin card shows the coin as a preview labelled "Preview, not launched", only when the city has a founder
//   that has a founder   and no launched coin (the server decides; this file only shows what it answers).
// Every value is set with textContent (never markup from text); the picture is an <img> of the server's own /coin-meta/art/<sha>.png.
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
  let ctx = null, seq = 0, last = null, drawingFor = null, busy = false;

  function styled() {
    if (Array.from(document.querySelectorAll('link[rel="stylesheet"]')).some((l) => /\/coin-ready\.css$/.test(l.getAttribute("href") || ""))) return;
    const l = document.createElement("link"); l.setAttribute("rel", "stylesheet"); l.setAttribute("href", "/coin-ready.css"); (document.head || document.body).append(l);
  }
  const text = (sel, t) => { const n = $(sel); if (n) n.textContent = t == null ? "" : String(t); return n; };
  const show = (sel, on) => { const n = $(sel); if (n) n.hidden = !on; return n; };
  const place = (c) => [c.name, c.region, c.countryName].filter(Boolean).join(" · ");
  const altOf = (ticker) => `$${ticker} coin: the Vicinity city coin design`;
  const errorText = (r, fallback) => (r && (ERR[r.error] || r.message)) || fallback;

  /* ---------- the founder's card ---------- */
  function paintFounder(r) {
    const card = $("#coin-ready");
    const coin = r.coin, gate = r.gate, chosen = r.chosen;
    // a launched coin is shown as itself by the coin card and the launch card; this card stays only for one launched with this design
    if (gate && gate.code === "launched" && !(chosen && chosen.launched)) { card.hidden = true; return; }
    card.hidden = false;
    text("#cr-place", r.city ? place(r.city) : "");
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
    text("#cr-version", coin && coin.version ? `Vicinity design ${coin.templateVersion} · Version ${coin.version}` : "");
    const g = show("#cr-gate", Boolean(gate));
    g.textContent = gate ? gate.message : "";
    const use = $("#cr-use"), st = $("#cr-state");
    let state = ["Ready", "tag--gold"], note = "";
    if (chosen && chosen.launched) { state = ["Launched", "tag--ok"]; note = "Your coin launched with this design. Its picture and words are fixed for good."; }
    else if (gate) state = ["Not available now", "tag--warn"];
    else if (r.inUse) { state = ["Your coin", "tag--ok"]; note = "This is your coin's design now. Next, Vicinity's owner approves it on the blockchain; then you launch it from your Founder tab."; }
    else if (chosen && chosen.current) note = "Vicinity's design or the city list changed since you chose your coin. This is the new version: use it to keep your coin up to date.";
    else if (chosen) note = "Your coin's design was changed since you chose it. Use this coin to choose it again.";
    st.textContent = state[0]; st.className = `tag ${state[1]}`;
    text("#cr-note", note);
    const usable = Boolean(coin && coin.contentHash && !gate && !r.inUse && !(chosen && chosen.launched));
    use.hidden = Boolean(r.inUse || (chosen && chosen.launched));
    use.disabled = !usable || busy;
    use.textContent = busy ? "Saving…" : "Use this coin";
    use.setAttribute("aria-label", coin ? `Use this coin: $${coin.ticker}, ${coin.name}` : "Use this coin");
  }

  /* ---------- the coin card's preview ---------- */
  function paintPreview(p, { founder = false } = {}) {
    const box = $("#coin-preview"), coinCard = $("#coin");
    if (!box || !coinCard) return;
    if (!p) { box.hidden = true; coinCard.classList.remove("has-preview"); return; }
    box.hidden = false; coinCard.classList.add("has-preview");
    const img = $("#coin-preview-art");
    if (p.art) { if (img.getAttribute("src") !== p.art) img.setAttribute("src", p.art); img.alt = altOf(p.ticker); img.hidden = false; }
    else { img.hidden = true; img.removeAttribute("src"); }
    text("#coin-preview-tag", p.label || "Preview, not launched");
    text("#coin-preview-ticker", `$${p.ticker}`);
    text("#coin-preview-name", [p.name, p.city && p.city.region, p.city && p.city.countryName].filter(Boolean).join(" · "));
    text("#coin-preview-note", founder
      ? `This is what $${p.ticker} will look like. You choose it in your Founder tab; nothing has launched yet.`
      : `This is what $${p.ticker} will look like once ${p.name}'s founder launches it. Made by Vicinity from the city list; nothing has launched yet.`);
    const st = $("#coin-status");
    if (st) { st.textContent = "Not launched"; st.className = "tag tag--warn"; }
    text("#coin-note", "");
  }

  /* ---------- reading, drawing, using ---------- */
  async function render(me) {
    const c = me && me.community;
    const my = ++seq;
    if (!c) { show("#coin-ready", false); paintPreview(null); return; }
    const r = await ctx.api(`/api/coins/ready?city=${encodeURIComponent(c.id)}`);
    if (my !== seq) return; // a newer render is on its way
    if (!r || r.ok === false) { show("#coin-ready", false); paintPreview(null); return; } // off (404) or unreadable: the page as before
    last = r;
    if (r.mode === "founder") {
      paintFounder(r);
      const p = r.coin && !(r.gate && r.gate.code === "launched") ? { label: "Preview, not launched", ticker: r.coin.ticker, name: r.coin.name, city: r.city, art: r.coin.art } : null;
      paintPreview(p, { founder: true });
      if (r.coin && !r.coin.art && !r.gate) draw(c.id);
    } else {
      show("#coin-ready", false);
      paintPreview(r.preview);
    }
  }
  /** The founder's picture, drawn once on the server (never again: the next answer carries it). */
  async function draw(cityId) {
    if (drawingFor === cityId) return;
    drawingFor = cityId;
    const r = await ctx.api("/api/coins/ready/art", { cityId });
    if (r && r.ok && r.mode === "founder") { last = r; paintFounder(r); paintPreview(r.coin ? { label: "Preview, not launched", ticker: r.coin.ticker, name: r.coin.name, city: r.city, art: r.coin.art } : null, { founder: true }); return; }
    text("#cr-art-wait", "Your coin's picture couldn't be made just now. Reload the page to try again.");
    drawingFor = null;
  }
  async function onUse() {
    const r0 = last;
    if (busy || !r0 || !r0.coin || !r0.coin.contentHash) return;
    busy = true; show("#cr-err", false); paintFounder(r0);
    let r;
    try { r = await ctx.sensitive(() => ctx.api("/api/coins/ready/use", { cityId: r0.city.id, contentHash: r0.coin.contentHash })); }
    finally { busy = false; }
    if (r && r.ok) {
      last = r; paintFounder(r);
      ctx.toast(`$${r.coin.ticker} is your coin`);
      if (ctx.changed) ctx.changed(); // the coin card and the launch card read the new design
      return;
    }
    if (r && r.error === "coin_changed" && r.coin) { last = r; paintFounder(r); }
    else paintFounder(r0);
    const e = text("#cr-err", errorText(r, "Couldn't use this coin just now. Nothing changed. Try again in a minute."));
    e.hidden = false;
  }

  window.VCoinReady = {
    init(c) {
      ctx = c;
      styled();
      $("#cr-use").addEventListener("click", onUse);
      return { render, state: () => last };
    },
  };
})();
