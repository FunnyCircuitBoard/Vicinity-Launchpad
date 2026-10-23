// Builds public/data/tickers.json: the ONE ticker for every community, so the map, the dashboard and the server
// can never disagree about a city coin's name (a test fails if this file is out of date).
//   npm run tickers
// A community is every listed place that isn't "part of" a bigger one (public/data/bounds/index.json → parts).
// Tickers come from public/ticker.js (the rules are in its header). A place with a name of its own is just its ticker;
// a name shared with other places is [ticker, plain ticker, how many places share the name].
//
// Launched tickers are PINNED (scripts/cities/ticker-pins.json): a coin's symbol is on the blockchain for ever, but this list is
// rebuilt from the whole city list, so adding a town could otherwise move a ticker (a bigger "Springfield" takes $SPRINGF and the
// launched one becomes $SPRINGFMA). A pinned city keeps its ticker, no other city can be given it, and the build FAILS (nothing is
// written) when a pin cannot hold: the city left the list or became a "part", a pin is not a ticker, or two pins share one.
// When a city coin launches, its city id and on-chain symbol go into the pins file. Launches happen on chain, not in a pull request, so
// the build does not trust the pins file alone: before anything is written it reads the official list of launched city coins (the live
// site's /api/official-coins, read from the chain; or a saved copy with --official <file>) and FAILS unless every launched coin's city
// is pinned to exactly its on-chain symbol (verifyLaunchedPinned). An approval the owner signed (approve_launch) already fixes a ticker
// on the blockchain before the coin launches, so the build also reads every Approval of the launchpad program (wrangler.jsonc's
// LAUNCHPAD_PROGRAM_ID, on its RPC; or a saved copy with --approvals <file>) and FAILS unless each live one keeps its symbol with its
// city in the new list (verifyApprovalsKept): pin it first, as for a launched coin. The pins are also published
// (public/data/ticker-pins.json) so the Cities page's fallback, which computes tickers itself when tickers.json can't be loaded, keeps them too.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import "../../public/ticker.js";

const pub = (p) => fileURLToPath(new URL(`../../public/${p}`, import.meta.url));
export const PINS_FILE = fileURLToPath(new URL("./ticker-pins.json", import.meta.url));
const plain = (v) => (typeof v === "string" ? v : v[0]);

/** The pins file's { cityId: "TICKER" } map. */
export const loadPins = (file = PINS_FILE) => JSON.parse(readFileSync(file, "utf8")).pins || {};

/** Throws unless every pin holds in `out` (tickers.json's shape): the city is there with exactly its pinned ticker, which nobody else has. */
export function verifyPins(out, pins) {
  const seen = new Map();
  for (const [id, t] of Object.entries(pins)) {
    if (!/^\d{1,19}$/.test(id) || typeof t !== "string" || !/^[A-Z0-9]{1,10}$/.test(t)) throw new Error(`ticker pin ${id}: ${JSON.stringify(t)} is not a city id with a ticker`);
    if (seen.has(t)) throw new Error(`ticker pins: $${t} is pinned to two cities (${seen.get(t)} and ${id})`);
    seen.set(t, id);
  }
  const owner = new Map();
  for (const [id, v] of Object.entries(out)) {
    const t = plain(v);
    if (owner.has(t)) throw new Error(`two communities share $${t} (${owner.get(t)} and ${id})`);
    owner.set(t, id);
  }
  for (const [id, t] of Object.entries(pins)) {
    if (!out[id]) throw new Error(`launched ticker $${t}: city ${id} is no longer a community in the list (pinned in ${PINS_FILE})`);
    if (plain(out[id]) !== t) throw new Error(`launched ticker moved: city ${id} launched as $${t} but would get $${plain(out[id])}`);
    if (owner.get(t) !== id) throw new Error(`launched ticker $${t} (city ${id}) would be given to city ${owner.get(t)}`);
  }
  return true;
}

/**
 * Throws unless every launched city coin is pinned to exactly its on-chain symbol. `official`: the /api/official-coins answer
 * ({ ok, coins: [{ cityId, ticker }] }); a list that is not readable, or a coin whose symbol it could not read, fails too (never
 * "nothing launched" by default).
 */
export function verifyLaunchedPinned(official, pins) {
  if (!official || official.ok !== true || !Array.isArray(official.coins)) throw new Error("the official list of launched city coins could not be read, so the pins can't be checked: nothing was written");
  for (const c of official.coins) {
    const id = String(c && c.cityId), t = c && c.ticker;
    if (!/^\d{1,19}$/.test(id) || typeof t !== "string" || !/^[A-Z0-9]{1,10}$/.test(t)) throw new Error(`launched coin of city ${id}: its on-chain ticker is not known (${JSON.stringify(t)}), so the pins can't be checked: nothing was written`);
    if (pins[id] !== t) throw new Error(`launched coin $${t} (city ${id}) is not pinned: add "${id}": "${t}" to ${PINS_FILE} first (it has ${pins[id] ? `$${pins[id]}` : "nothing"})`);
  }
  return true;
}
/**
 * Throws unless every live approval on chain (`approvals`: [{ cityId, symbol, expiresAt (seconds) }], expired ones skipped: the program
 * refuses to launch them) keeps its symbol in `out` (tickers.json's shape): its city has exactly that ticker, and no other city has it.
 */
export function verifyApprovalsKept(out, approvals, now = Date.now()) {
  if (!Array.isArray(approvals)) throw new Error("the launchpad's approvals could not be read, so their tickers can't be checked: nothing was written");
  const holder = new Map();
  for (const [id, v] of Object.entries(out)) holder.set(plain(v), id);
  for (const a of approvals) {
    if (!(Number(a.expiresAt) * 1000 > now)) continue;
    const id = String(a.cityId), mine = out[id] ? plain(out[id]) : null;
    if (mine !== a.symbol || holder.get(a.symbol) !== id) {
      throw new Error(`approved coin $${a.symbol} (city ${id}) would ${mine ? `become $${mine}` : "leave the list"}${holder.has(a.symbol) && holder.get(a.symbol) !== id ? ` and $${a.symbol} would go to city ${holder.get(a.symbol)}` : ""}: add "${id}": "${a.symbol}" to ${PINS_FILE} first, or have the owner revoke that approval`);
    }
  }
  return true;
}
/** The Approval account's size (vicinity_launchpad state.rs, InitSpace): every approval the same. */
const APPROVAL_SIZE = 179;
/**
 * Every Approval of the launchpad program on chain: [{ cityId, symbol, name, founder, expiresAt }], read with one getProgramAccounts.
 * `settings`: wrangler.jsonc's vars (LAUNCHPAD_PROGRAM_ID, LAUNCHPAD_RPC_URL or SOLANA_RPC_URL). No program set: no approval exists.
 */
export async function readApprovals(settings, fetchImpl = fetch) {
  const programId = settings && settings.LAUNCHPAD_PROGRAM_ID;
  if (!programId) return [];
  const rpc = settings.LAUNCHPAD_RPC_URL || settings.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  const { decodeApproval } = await import("../../src/lpadmin.js");
  const res = await fetchImpl(rpc, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getProgramAccounts", params: [programId, { encoding: "base64", commitment: "confirmed", filters: [{ dataSize: APPROVAL_SIZE }] }] }) });
  const body = await res.json();
  if (!res.ok || !body || body.error || !Array.isArray(body.result)) throw new Error(`the launchpad's approvals could not be read (${(body && body.error && body.error.message) || res.status}): nothing was written`);
  const out = [];
  for (const r of body.result) {
    const ap = decodeApproval(r && r.account ? { ...r.account, owner: r.account.owner || programId } : null, programId);
    if (ap) out.push({ cityId: ap.cityId.toString(), symbol: ap.symbol, name: ap.name, founder: ap.founder, expiresAt: ap.expiresAt });
  }
  return out;
}
/** wrangler.jsonc's vars (comments and trailing commas stripped), as scripts/mainnet-preflight.mjs reads them. */
export const wranglerVars = (file = fileURLToPath(new URL("../../wrangler.jsonc", import.meta.url))) =>
  JSON.parse(readFileSync(file, "utf8").replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1")).vars || {};

/** Where the official list is read from by default: the live site (mainnet), which reads it from the chain. */
export const OFFICIAL_URL = "https://vicinity.city/api/official-coins";
export const PUBLIC_PINS = pub("data/ticker-pins.json");
/** The published copy of the pins (public/data/ticker-pins.json): the same map, for the Cities page's fallback. */
export const publicPins = (pins = loadPins()) => JSON.stringify({ pins });

/** tickers.json's content. `cities`, `parts` and `pins` default to the committed files (the tests hand in their own). */
export function buildTickers({ cities = null, parts = null, pins = null } = {}) {
  const list = cities || JSON.parse(readFileSync(pub("data/cities.json"), "utf8"));
  const partOf = parts || JSON.parse(readFileSync(pub("data/bounds/index.json"), "utf8")).parts || {};
  const pinned = pins || loadPins();
  const rows = [];
  for (const [cc, l] of Object.entries(list.byCountry))
    for (const [id, name, adm, , , pop] of l) if (!partOf[String(id)]) rows.push({ id: String(id), name, adm, cc, pop });
  const out = {};
  for (const [id, t] of globalThis.vicinityTicker.assign(rows, { pinned })) out[id] = t.shared === 1 && t.ticker === t.base ? t.ticker : [t.ticker, t.base, t.shared];
  verifyPins(out, pinned);
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const at = process.argv.indexOf("--official");
  const official = at > 0 ? JSON.parse(readFileSync(process.argv[at + 1], "utf8")) : await fetch(OFFICIAL_URL).then((r) => r.json()).catch((e) => { console.error("official coins:", String(e && e.message)); return null; });
  verifyLaunchedPinned(official, loadPins()); // throws: nothing is written
  const ap = process.argv.indexOf("--approvals");
  const approvals = ap > 0 ? JSON.parse(readFileSync(process.argv[ap + 1], "utf8")) : await readApprovals(wranglerVars());
  const out = buildTickers();
  verifyApprovalsKept(out, approvals); // throws: nothing is written
  writeFileSync(pub("data/tickers.json"), JSON.stringify(out));
  writeFileSync(PUBLIC_PINS, publicPins());
  console.log("tickers ready:", Object.keys(out).length, "communities;", official.coins.length, "launched coins, all pinned;", approvals.length, "approvals on chain, every live one kept");
}
