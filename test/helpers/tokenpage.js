// The built token page with the real public/token.js on test/helpers/pagedom.js (no browser): `official` is what /api/official
// answers (a promise), `list` the holder rows /api/holders answers in one page (null: the chain is busy; `holdersExtra` rides along in
// that answer, e.g. { stale: true } or the live supply), `rank` the /api/rank answer for each address, `coin` the /api/coin answer (the
// page asks for it once `official` says launchpadV2; left out, the route's own "not enabled"), `token` the /api/token answer, `hash`
// and `search` the address bar. Returns the page, settle(), the row of a wallet, $, $$, the document, press() (a key on the focused
// element), hashTo() (the hash changes while the page is open), every /api call made, and the console's errors and warnings (none are
// expected). Used by test/team-lock.test.js, test/team-order.test.js and test/token-tabs.test.js.
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { newEvent, openPage } from "./pagedom.js";

export const VICINITY = "2aVkhRfAEm44tMhFo8oamWvumGGvweFqnUwukRMBkray";
const read = (p) => readFileSync(new URL("../../" + p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const FACTS = { mint: VICINITY, program: "SPL Token", decimals: 6, supply: 1e9, mintAuthority: null, freezeAuthority: null, mintingDisabled: true, freezingDisabled: true, mintHeldByProgram: false };

export async function tokenPage({ official, list, rank = {}, now = "2026-10-13T20:00:00Z", coin, token, hash = "", search = "", holdersExtra = {} }) {
  const page = await openPage("token.html");
  const win = page.window, frames = [], errors = [], calls = [];
  const T = Date.parse(now);
  win.Date = class extends Date { constructor(...a) { super(...(a.length ? a : [T])); } static now() { return T; } };
  win.location = { hash, search, pathname: "/token", href: `https://vicinity.city/token${search}${hash}` };
  // history.replaceState as token.js uses it (the chosen tab goes into the address bar without a jump): the hash is what a test reads back
  win.history = { replaceState(_state, _title, url) { const u = String(url), i = u.indexOf("#"); win.location.hash = i >= 0 ? u.slice(i) : ""; } };
  win.requestAnimationFrame = (f) => frames.push(f);
  Object.assign(win, { scrollX: 0, scrollY: 0, innerHeight: 800, scrollTo() {} });
  win.console = { ...console, error: (...a) => errors.push(a.map(String).join(" ")), warn: (...a) => errors.push(a.map(String).join(" ")) };
  const answer = (path) => {
    const p = String(path).split("?")[0];
    if (p === "/api/token") return token || { launched: true, registry: [], facts: FACTS, price: null };
    if (p === "/api/holders") return list === null ? { launched: true, error: "chain_unavailable" }
      : { launched: true, mint: VICINITY, supply: 1e9, total: list.filter((h) => h.rank).length, count: list.length, full: true, holders: list, more: false, updatedAt: "2026-10-13T19:59:00Z", ...holdersExtra };
    if (p === "/api/rank") return rank[new URL(path, "https://x").searchParams.get("address")];
    if (p === "/api/coin") return coin === undefined ? { ok: false, error: "not_enabled" } : typeof coin === "function" ? coin(path) : coin;
    return { ok: true };
  };
  win.fetch = async (path) => { calls.push(String(path)); const body = answer(path); return { ok: true, status: 200, json: async () => body }; };
  win.V.official = official;
  const pop = page.$("#rank-pop"); pop.showModal = () => { pop.open = true; }; pop.close = () => { pop.open = false; };
  vm.runInContext(read("public/token.js"), win, { filename: "public/token.js" });
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); while (frames.length) frames.shift()(); };
  await settle();
  const rowOf = (owner) => page.$$("#holders-body tr").find((tr) => tr.dataset.owner === owner);
  /** The address bar's hash changes while the page is open (a link on the page): the window's hashchange listeners run. */
  const hashTo = (h) => { win.location.hash = h; for (const l of [...win.listeners]) if (l.type === "hashchange") l.fn.call(win, newEvent("hashchange")); };
  return { page, settle, rowOf, $: page.$, $$: page.$$, doc: page.doc, press: page.press, win, calls, errors, hashTo };
}
