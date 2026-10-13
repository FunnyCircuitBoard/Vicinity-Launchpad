// The built token page with the real public/token.js on test/helpers/pagedom.js (no browser): `official` is what /api/official
// answers (a promise), `list` the holder rows /api/holders answers in one page (null: the chain is busy), `rank` the /api/rank answer
// for each address. Used by test/team-lock.test.js and test/team-order.test.js.
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { openPage } from "./pagedom.js";

export const VICINITY = "2aVkhRfAEm44tMhFo8oamWvumGGvweFqnUwukRMBkray";
const read = (p) => readFileSync(new URL("../../" + p, import.meta.url), "utf8").replace(/\r\n/g, "\n");

export async function tokenPage({ official, list, rank = {}, now = "2026-10-13T20:00:00Z" }) {
  const page = await openPage("token.html");
  const win = page.window, frames = [];
  const T = Date.parse(now);
  win.Date = class extends Date { constructor(...a) { super(...(a.length ? a : [T])); } static now() { return T; } };
  win.location = { hash: "", search: "", pathname: "/token", href: "https://vicinity.city/token" };
  win.requestAnimationFrame = (f) => frames.push(f);
  Object.assign(win, { scrollX: 0, scrollY: 0, innerHeight: 800, scrollTo() {} });
  const answer = (path) => {
    const p = String(path).split("?")[0];
    if (p === "/api/token") return { launched: true, registry: [], facts: { mint: VICINITY, program: "SPL Token", decimals: 6, supply: 1e9, mintAuthority: null, freezeAuthority: null, mintingDisabled: true, freezingDisabled: true, mintHeldByProgram: false }, price: null };
    if (p === "/api/holders") return list === null ? { launched: true, error: "chain_unavailable" }
      : { launched: true, mint: VICINITY, supply: 1e9, total: list.filter((h) => h.rank).length, count: list.length, full: true, holders: list, more: false, updatedAt: "2026-10-13T19:59:00Z" };
    if (p === "/api/rank") return rank[new URL(path, "https://x").searchParams.get("address")];
    return { ok: true };
  };
  win.fetch = async (path) => { const body = answer(path); return { ok: true, status: 200, json: async () => body }; };
  win.V.official = official;
  const pop = page.$("#rank-pop"); pop.showModal = () => { pop.open = true; }; pop.close = () => { pop.open = false; };
  vm.runInContext(read("public/token.js"), win, { filename: "public/token.js" });
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); while (frames.length) frames.shift()(); };
  await settle();
  const rowOf = (owner) => page.$$("#holders-body tr").find((tr) => tr.dataset.owner === owner);
  return { page, settle, rowOf, $: page.$ };
}
