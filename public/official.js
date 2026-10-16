/* The Official addresses page (/official, built by scripts/pages/build.mjs from src/official.js): the Copy buttons of the addresses the
   page already shows, and the official city coins, read from the chain by GET /api/official-coins (src/officialcoins.js). The list says
   only what that answer says: a coin on it (with its pool and its coin record on Solscan, so anyone can check it), "no city coin on the
   list yet" when the chain says none, and when the chain could not be read, that it could not (never an empty list in its place). A
   list of another network than mainnet is not shown: its links would open mainnet pages. */
(() => {
  const { $, $$, el, api, copy } = window.V;
  const wire = (b) => { b.hidden = false; b.addEventListener("click", () => copy(b.dataset.copy, "Address copied")); };
  $$("[data-copy]").forEach(wire);

  const STAGE = { curve: "On its price curve", full: "Curve full, waiting to graduate", graduated: "Graduated to its pool" };
  const solscan = (kind, a) => `https://solscan.io/${kind}/${encodeURIComponent(a)}`;
  const isAddr = (a) => typeof a === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);
  const out = (href, text, what) => {
    const a = el("a", "btn btn--ghost btn--sm", text);
    a.href = href; a.setAttribute("target", "_blank"); a.setAttribute("rel", "noopener");
    a.append(el("span", "sr-only", `: ${what} (opens in a new tab)`));
    return a;
  };
  const time = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? null : `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`; };

  function row(c) {
    const tr = el("tr");
    tr.dataset.mint = c.mint;
    const city = el("td", null, typeof c.city === "string" && c.city ? c.city : `City ${c.cityId}`);
    const ticker = el("td", null, typeof c.ticker === "string" && c.ticker ? `$${c.ticker}` : "Not read");
    const mint = el("td", "off-mint");
    const code = el("code", "off-row__value", c.mint);
    const b = el("button", "btn btn--ghost btn--sm", "Copy");
    b.setAttribute("type", "button"); b.dataset.copy = c.mint; b.setAttribute("aria-label", `Copy the address (${city.textContent} mint)`);
    wire(b);
    const acts = el("span", "off-row__acts");
    acts.append(b, out(solscan("token", c.mint), "Solscan", `${city.textContent} mint`));
    mint.append(code, acts);
    const stage = el("td", null, STAGE[c.stage] || "Not read");
    const links = el("span", "off-row__acts");
    if (isAddr(c.pool)) links.append(out(solscan("account", c.pool), "Pool", `${city.textContent} pool on Solscan`));
    if (isAddr(c.coinAccount)) links.append(out(solscan("account", c.coinAccount), "Record", `${city.textContent} coin record on Solscan`));
    if (links.childNodes.length) { stage.append(" "); stage.append(links); }
    tr.append(city, ticker, mint, stage);
    return tr;
  }

  (async () => {
    const state = $("#coins-state"), wrap = $("#coins-wrap"), body = $("#coins-body");
    if (!state || !wrap || !body) return;
    const d = await api("/api/official-coins");
    if (!d || d.ok !== true || !Array.isArray(d.coins)) {
      state.textContent = d && d._status === 404 ? "The city-coin list is not on this site right now."
        : d && d._status === 429 ? "Too many requests from your connection just now. Please try again in a minute."
          : "The list could not be read from the chain just now. Please try again in a few minutes.";
      return;
    }
    if (d.cluster !== "mainnet") { state.textContent = "The city-coin list is not on this site right now."; return; }
    const coins = d.coins.filter((c) => c && isAddr(c.mint));
    const at = time(d.readAt);
    if (!coins.length) { state.textContent = `No city coin is on the list yet.${at ? ` Read from the chain at ${at}.` : ""}`; return; }
    body.replaceChildren(...coins.map(row));
    wrap.hidden = false;
    state.textContent = `${coins.length} official city coin${coins.length === 1 ? "" : "s"}.${at ? ` Read from the chain at ${at}.` : ""}`;
  })();
})();
