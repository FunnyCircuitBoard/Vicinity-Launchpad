// City coin tickers for the Vicinity Launchpad (preview). Plain script: sets globalThis.vicinityTicker.
//
// Rules, so two cities can never end up with the same coin:
//   1. Every city has a unique ID. The ID is what gets claimed, never the name.
//   2. Ticker = the city name in capital letters, at most 10 characters.
//      Long names shorten: "New York City" → NYC, "Kuala Lumpur" → KUALALUM.
//   3. Same name in several places? The biggest city keeps the plain ticker.
//      The others add their country code ($LONDONCA), and if the country has
//      more than one, their state/region code too ($SPRINGFMA).
(function (root) {
  "use strict";
  const MAX = 10;
  const SPECIAL = { "Ł": "L", "ł": "l", "Ø": "O", "ø": "o", "Æ": "AE", "æ": "ae", "ß": "ss", "Đ": "D", "đ": "d", "Þ": "TH", "þ": "th", "Œ": "OE", "œ": "oe", "ı": "i", "Ð": "D", "ð": "d" };

  function words(name) {
    const plain = String(name).replace(/[ŁłØøÆæßĐđÞþŒœıÐð]/g, (c) => SPECIAL[c]).normalize("NFD").replace(/\p{M}/gu, "");
    return plain.toUpperCase().split(/[^A-Z]+/).filter(Boolean);
  }

  /** Ticker from the name alone (before resolving clashes). */
  function baseTicker(name) {
    const w = words(name);
    if (!w.length) return "";
    const compact = w.join("");
    if (compact.length <= MAX) return compact;
    if (w.length >= 3) return w.map((x) => x[0]).join("").slice(0, MAX);
    if (w.length === 2) return (w[0].slice(0, 7) + w[1].slice(0, 3)).slice(0, MAX);
    return compact.slice(0, MAX);
  }

  const cut = (base, suffix) => base.slice(0, Math.max(2, MAX - suffix.length)) + suffix;

  /**
   * Give every city a unique ticker.
   * cities: [{ id, name, cc, adm, pop }] → Map(id → { ticker, base, shared })
   *   shared = how many listed cities have the same base ticker (1 = unique).
   * pinned (optional): { id: ticker } of every city whose coin has LAUNCHED (scripts/cities/ticker-pins.json). A launched coin's
   *   ticker is on the blockchain for ever, so its city keeps it whatever the list becomes (a new town with the same name and more
   *   people would otherwise take the plain ticker), and no other city can be given it.
   */
  function assign(cities, { pinned = null } = {}) {
    const pins = new Map(Object.entries(pinned || {}).map(([id, t]) => [String(id), t]));
    const groups = new Map();
    for (const c of cities) {
      const b = baseTicker(c.name) || c.cc + "CITY";
      if (!groups.has(b)) groups.set(b, []);
      groups.get(b).push(c);
    }
    const out = new Map(), used = new Set();
    for (const c of cities) if (pins.has(String(c.id))) used.add(pins.get(String(c.id))); // reserved before anyone is given a ticker
    const take = (c, t, base, shared) => {
      if (pins.has(String(c.id))) { out.set(c.id, { ticker: pins.get(String(c.id)), base, shared }); return; }
      let final = t, n = 2;
      while (used.has(final)) { const s = String(n++); final = t.slice(0, MAX - s.length) + s; }
      used.add(final); out.set(c.id, { ticker: final, base, shared });
    };
    // Plain tickers first, so a suffixed ticker can never take a plain one.
    const later = [];
    for (const [b, list] of groups) {
      list.sort((x, y) => (y.pop || 0) - (x.pop || 0) || String(x.id).localeCompare(String(y.id)));
      take(list[0], b, b, list.length);
      for (const c of list.slice(1)) later.push([b, list, c]);
    }
    for (const [b, list, c] of later) {
      const sameCountry = list.filter((x) => x.cc === c.cc).length;
      const adm = /^[A-Z]{1,3}$/.test(c.adm || "") ? c.adm : String(c.adm || "").replace(/[^A-Z0-9]/gi, "").toUpperCase().slice(0, 3);
      const suffix = sameCountry > 1 && adm ? (c.cc === list[0].cc ? adm : c.cc + adm).slice(0, 5) : c.cc;
      take(c, cut(b, suffix), b, list.length);
    }
    return out;
  }

  root.vicinityTicker = { baseTicker, assign, MAX };
})(typeof globalThis !== "undefined" ? globalThis : window);
