// The map's "city in focus" card (public/cities.js renderFocus + announce), run on a pretend page with a fake clock. Pinned here:
// * the card never stays blank: a fade that a city change started is ended by every later fill, including the one a data
//   refresh asks for at once (refreshMembers / refreshClaims reset focusSig): the review measured the card at opacity 0 for
//   8 s and more after /api/members answered while the overview boundary was arriving;
// * new numbers for the same city (the boundary's km², a member, the countdown) go in at once, without a fade;
// * the polite announcement is made once per city and status: the countdown of a choosing city stays on the card only, so the
//   35-word sentence is not re-read every minute while nothing moves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const js = readFileSync(new URL("../public/cities.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const slice = (from, to) => { const a = js.indexOf(from), b = js.indexOf(to, a); assert.ok(a > 0 && b > a, from); return js.slice(a, b); };
const RENDER = slice("  function renderFocus() {", "  /** Screen readers hear");
const ANNOUNCE = slice("  function announce(text) {", "\n  $(\"#mf-open\")");

function page() {
  const timers = [];
  let now = 0;
  const node = (id) => ({ id, textContent: "", hidden: false, className: "", disabled: false, attrs: {}, dataset: {}, kids: [],
    setAttribute(k, v) { this.attrs[k] = v; }, replaceChildren(...k) { this.kids = k; this.textContent = k.map((x) => x.textContent).join(""); },
    append(...k) { this.kids.push(...k); this.textContent += k.map((x) => x.textContent).join(""); } });
  const els = Object.fromEntries(["#mf-name", "#mf-where", "#mf-mini", "#mf-status", "#mf-ticker", "#mf-amount", "#mf-area", "#mf-line", "#mf-open", "#mf-say"].map((s) => [s, node(s)]));
  const cls = new Set();
  const focusEl = { dataset: {}, classList: { add: (...c) => c.forEach((x) => cls.add(x)), remove: (...c) => c.forEach((x) => cls.delete(x)), contains: (c) => cls.has(c) } };
  const city = { id: "2314302", name: "Kinshasa", cc: "CD", pop: 7785965, lon: 15.3, lat: -4.3 };
  const ctx = {
    focusEl, $: (s) => els[s], document: { createTextNode: (t) => ({ textContent: t }) }, el: (tag, c, t) => ({ textContent: t || "", href: "" }),
    byId: new Map([[city.id, city]]), claims: new Map(), windows: new Map(), members: new Map(), memberCount: new Map(), holderCount: new Map(), joined: new Set(),
    ov: { failed: false }, area: null, compact: new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }),
    fmt: (n) => Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 }), placeOf: () => "Kinshasa, DR Congo",
    tickerOf: () => "KINSHASA", founderMin: () => 650000, until: (iso, t) => `${Math.round((Date.parse(iso) - t) / 60000)}m`,
    toLonLat: () => [0, 0], nearestCommunities: () => [], fcx: 0, fcy: 0,
    FOCUS_TAG: { open: ["tag tag--ok", "Open"], choosing: ["tag tag--gold", "Choosing"], founded: ["tag tag--no", "Founded"], mine: ["tag tag--warn", "Yours"] },
    STATUS_WORD: { open: "Open", choosing: "Choosing its founder", founded: "Founded", mine: "Yours" },
    setTimeout: (f, ms) => { timers.push({ f, at: now + ms }); return timers.length; }, clearTimeout: (i) => { if (timers[i - 1]) timers[i - 1].f = null; },
    Date: { now: () => Date.parse("2026-10-06T12:00:00Z") + now },
  };
  vm.createContext(ctx);
  vm.runInContext(`
    let focusId = "2314302", focusSig = "", nearestGo = null, swapping = 0, sayTimer = 0, reduced = false, membersKnown = false;
    const statusOf = (c) => (windows.has(c.id) ? "choosing" : "open");
    const areaFacts = () => area;
    const areaNote = (a) => (a ? "Official boundary + nearest land · " + fmt(a.km2) + " km²" : "");
    ${RENDER}
    ${ANNOUNCE}
    this.api = { renderFocus, reset: () => { focusSig = ""; }, known: () => { membersKnown = true; } };
  `, ctx);
  const run = (ms) => { now += ms; for (const t of timers) if (t.f && t.at <= now) { const f = t.f; t.f = null; f(); } };
  return { ...ctx.api, ctx, els, cls, run, city };
}

test("focus card: a data refresh in the middle of a fade still ends with the card shown (it stayed blank for 8 s and more)", () => {
  const P = page();
  P.renderFocus(); // first fill: no fade
  assert.equal(P.els["#mf-name"].textContent, "Kinshasa");
  assert.equal(P.cls.has("is-swapping"), false);
  // another city comes into focus: a fade starts (140 ms)
  P.ctx.byId.set("2988507", { id: "2988507", name: "Paris", cc: "FR", pop: 2138551 });
  vm.runInContext(`focusId = "2988507"`, P.ctx);
  P.renderFocus();
  assert.equal(P.cls.has("is-swapping"), true, "the card fades out");
  // /api/members answers inside those 140 ms: refreshMembers resets focusSig and asks again
  P.run(60); P.known(); P.reset(); P.renderFocus();
  assert.equal(P.cls.has("is-swapping"), false, "the fill that follows ends the fade");
  assert.equal(P.els["#mf-name"].textContent, "Paris");
  P.run(200);
  assert.equal(P.cls.has("is-swapping"), false, "and the older turn's timer leaves it alone");
  assert.equal(P.els["#mf-name"].textContent, "Paris");
});

test("focus card: new numbers for the same city go in at once, without a fade", () => {
  const P = page();
  P.renderFocus();
  assert.match(P.els["#mf-area"].textContent, /Boundary loading/);
  P.ctx.area = { km2: 17995, kind: "r" };
  P.renderFocus();
  assert.equal(P.cls.has("is-swapping"), false, "the boundary's km² arrives: no fade");
  assert.match(P.els["#mf-area"].textContent, /^17,995 km²/);
  P.known(); P.reset(); P.renderFocus();
  assert.equal(P.cls.has("is-swapping"), false);
  assert.match(P.els["#mf-line"].textContent, /No founder yet · 0 members/);
});

test("focus card: the countdown ticks on the card, the polite announcement is made once", () => {
  const P = page();
  P.ctx.windows.set("2314302", { applicants: 1, closesAt: "2026-10-06T14:04:00Z" });
  P.renderFocus(); P.run(700);
  const said = P.els["#mf-say"].textContent;
  assert.match(said, /^In focus: Kinshasa, Kinshasa, DR Congo\. Choosing its founder, 1 applying\./);
  assert.doesNotMatch(said, /closes in/, "no countdown in the announcement");
  assert.match(P.els["#mf-line"].textContent, /1 applying · closes in 124m/);
  let writes = 0;
  const say = P.els["#mf-say"];
  let text = say.textContent;
  Object.defineProperty(say, "textContent", { get: () => text, set: (v) => { writes++; text = v; } });
  for (let minute = 1; minute <= 3; minute++) { P.run(60000); P.reset(); P.renderFocus(); P.run(700); }
  assert.match(P.els["#mf-line"].textContent, /closes in 121m/, "the card keeps time");
  assert.equal(writes, 0, "the live region is not rewritten while nothing but the countdown changes");
  // a new applicant is news: said again
  P.ctx.windows.set("2314302", { applicants: 2, closesAt: "2026-10-06T14:04:00Z" });
  P.reset(); P.renderFocus(); P.run(700);
  assert.equal(writes, 1);
  assert.match(text, /Choosing its founder, 2 applying\./);
});
