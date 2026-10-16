/**
 * Are Meteora's programs still the builds the team tested? (recognition step R3)
 *
 * Every city coin runs on two Meteora programs this site does not control: the bonding curve (DBC, the price curve every coin
 * trades on) and DAMM v2 (the pool a coin moves to after graduation). The team tested our launchpad against ONE build of each:
 * solana/scripts/launchpad/fetch-fixtures.sh dumps them from the chain and checks these same SHA-256 values; solana/LAUNCHPAD-DESIGN.md
 * section 17 lists them. Meteora can upgrade either program at any time, and a build nobody here tested must not get a new approval,
 * a new allow-list entry or a new launch from this site until the team has re-tested it. So before any of those is built, the
 * Worker reads both programs (getMultipleAccounts through its RPC pool: reads, never a transaction), fingerprints their bytes the
 * way the admin tab fingerprints our own programs, and compares them with the pins below. Approvals and launches already on chain
 * are not touched: this site cannot and does not change them, and a founder who holds an approval can still send `launch` to our
 * program with other tools (the owner's lever for that is Pause launches).
 *
 *   PINS                               per cluster (mainnet and devnet run different builds): { programId, programData, sha256 } of dbc
 *                                      and dammV2, copied from fetch-fixtures.sh. A value here is NEVER edited to make the check pass:
 *                                      a changed Meteora program is re-tested by the team first, then re-pinned there, in the design
 *                                      file and here, in one change.
 *   programHashes(env, fetchImpl, now, { fresh, route })
 *                                      { cluster, dbc: { programId, programData, slot, size, sha256, pinned, ok }, dammV2: { ... },
 *                                      ok, which: ["dbc" | "dammV2"], readAt } (frozen); when the chain could not be read (or an
 *                                      account is missing) { ..., unavailable: true, ok: false }: an unreadable chain is an unknown
 *                                      build, never "ok" by default. Kept 10 minutes per server for the pages; `fresh` (the routes that
 *                                      build) reads the deploy slots again every time, itself; a failure is asked again on the next request.
 *                                      A reading older than a deploy this server has already read (a node that lags) is unavailable.
 *                                      Two limits. A new server whose first readings all come from a node that lags (the backup after
 *                                      429s) has nothing newer to compare with, so it judges the build that node still holds (unknowable
 *                                      without asking the node for a minimum slot). And the newest deploy slot is raised as soon as a
 *                                      header names it, before the program's bytes are read, and never lowered, so a deploy seen at
 *                                      "confirmed" and then dropped (or a made-up header from a node whose genesis hash matched) holds
 *                                      every build at 503 until the server restarts (on the side of refusing).
 *                                      The ONE reading of Meteora's programs on this server: approvals, setup steps 3 and 4, the record
 *                                      step of a price curve and a founder's launch all go through it (src/lpadmin.js's step 3 and that
 *                                      record step compare its DBC fingerprint with DBC_PROGRAM_SHA256: 409 program_changed / 503
 *                                      program_check_unavailable for the build, dbc_changed / dbc_unreadable for the record).
 *   programRefusal(hashes, what)       the answer a route gives when it must not build: { status: 409, error: "program_changed", which,
 *                                      message } or { status: 503, error: "program_check_unavailable", ... }; null when both are as tested.
 *   programSummary(hashes)             what the pages show: { state: ok | changed | unavailable, which, checkedAt, message, dbc, dammV2 }
 *   fingerprint(account)               { size, sha256 } of a ProgramData account's program bytes (the loader's 45-byte header skipped):
 *                                      the one hashing function this file and src/lpadmin.js share. null when it is not one, or not
 *                                      clearly all of one (no owner or no `space` in the answer, or fewer bytes than that `space`).
 */
import { lpSetup } from "./cluster.js";
import { lpRpc, readAccounts } from "./lpkit.js";
import { codeOf } from "./sources.js";
import { iso } from "./policy.js";
import { PROGRAM_IDS } from "./sol/pda.js";
import { accountBytes, decodeProgramData } from "./sol/dbc.js";

const pin = (programData, sha256) => Object.freeze({ programId: null, programData, sha256 });
/**
 * From solana/scripts/launchpad/fetch-fixtures.sh (the ProgramData addresses are the upgradeable loader's PDAs of the program ids,
 * src/sol/pda.js programDataAddress; test/program-pins.test.js checks all of it against that script).
 */
export const PINS = Object.freeze({
  // mainnet: re-pinned on 16 Oct 2026 after the team re-tested Meteora's upgrades (DBC 0.2.2, deploy slot 457,502,600; DAMM v2
  // 0.2.5, deploy slot 457,080,014; LAUNCHPAD-DESIGN.md section 17). The DBC pin is also DBC_PROGRAM_SHA256 (src/sol/dbc-config-data.js).
  mainnet: Object.freeze({
    dbc: Object.freeze({ ...pin("HUfnSSiJxgspQm6C1rkqv6L3XgVtn7AESApgCQpCXCYh", "e2bfc853c1a1778dd8ee40ea9a0f3edf5587442360c57c685e7e3024ad0cad47"), programId: PROGRAM_IDS.dbc }),
    dammV2: Object.freeze({ ...pin("AUh8bm2XsMfex3KjYGcM3G4uBqUNSDw6HEhWaWMYnyPH", "967ff9fb161eec2e62f66d2c899100739fb747c445f697b8625c86b31b9a2022"), programId: PROGRAM_IDS.damm }),
  }),
  // devnet: read on 6 Oct 2026, deploy slots 503,167,099 (DBC) and 503,166,267 (DAMM v2); solana/LAUNCHPAD-DEVNET.md. Devnet's DBC was
  // upgraded since (16 Oct 2026, not re-tested), so its pin stays and devnet's approvals wait (fetch-fixtures.sh reports FAIL for it too)
  devnet: Object.freeze({
    dbc: Object.freeze({ ...pin("HUfnSSiJxgspQm6C1rkqv6L3XgVtn7AESApgCQpCXCYh", "f5ccbb01e37165d16108bda0259fb3acbfca29305e23098c3b248e50c22979f0"), programId: PROGRAM_IDS.dbc }),
    dammV2: Object.freeze({ ...pin("AUh8bm2XsMfex3KjYGcM3G4uBqUNSDw6HEhWaWMYnyPH", "82bb9375921bb8007551cb65f9ca43b191597496cc9922926468b36671081ec2"), programId: PROGRAM_IDS.damm }),
  }),
});
export const PROGRAM_WORDS = Object.freeze({ dbc: "bonding-curve program", dammV2: "DAMM v2 pool program" });
export const CACHE_MS = 10 * 60_000;
const BODIES_MAX = 50;

const cache = new Map(); // "<cluster>|<rpc>" -> { at, result } (frozen; never a failed read): the answer read last
const bodies = new Map(); // "<cluster>|<programData>|<slot>" -> { size, sha256 }: the bytes of one deploy (a deploy always writes a new slot)
const newest = new Map(); // "<cluster>|<programData>" -> the highest deploy slot this server has read (BigInt; slots only grow)
const inflight = new Map(); // "<cluster>|<rpc>" -> the latest refresh under way (a page waits for it instead of reading again)
let pins = PINS;
/** Tests: forget what this server remembers of the check (src/lpadmin.js _resetLpAdmin calls it too). */
export const _forgetProgramHashes = () => { cache.clear(); bodies.clear(); newest.clear(); inflight.clear(); };
/** Tests: that, and the real pins again. */
export const _resetProgramPins = () => { _forgetProgramHashes(); pins = PINS; };
/**
 * Tests only (never called by the Worker; nothing in a request can reach it): a test chain's made-up program bytes can never hash
 * to the real pins, so a test world pins its own stand-in builds. `over` = { devnet: { dbc: "<hex>", dammV2: "<hex>" } }.
 */
export const _setProgramPinsForTests = (over) => {
  pins = { ...PINS };
  for (const [cluster, table] of Object.entries(over)) {
    pins[cluster] = { ...PINS[cluster] };
    for (const [k, sha256] of Object.entries(table)) pins[cluster][k] = { ...PINS[cluster][k], sha256 };
  }
  _forgetProgramHashes();
};

const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");
/**
 * { size, sha256 } of the program bytes in a ProgramData account (the same bytes `solana program dump` writes), or null: also when
 * the answer names no owner, or does not say the account's `space` (every current RPC does), or holds fewer bytes than that (a node
 * that cut it short): a hash of bytes that may not be all of the program is not the program's.
 */
export async function fingerprint(account) {
  const a = accountBytes(account);
  if (!a || a.owner !== PROGRAM_IDS.upgradeableLoader || a.bytes.length < 45) return null;
  if (account.space === undefined || account.space === null || a.bytes.length !== Number(account.space)) return null;
  const body = a.bytes.subarray(45);
  return { size: body.length, sha256: hex(await crypto.subtle.digest("SHA-256", body)) };
}

const KEYS = ["dbc", "dammV2"];
/** The deploy slot of a ProgramData answer the loader owns (a header or the whole account), or null. */
const programData = (acc) => (acc && acc.owner === PROGRAM_IDS.upgradeableLoader ? decodeProgramData(acc) : null);
const unread = (p) => ({ programId: p.programId, programData: p.programData, slot: null, size: null, sha256: null, pinned: p.sha256, ok: false });
/** An answer every caller shares for ten minutes: nothing may change it afterwards (from "changed" to "ok", say). */
const frozen = (out) => { Object.freeze(out.which); for (const k of KEYS) if (out[k]) Object.freeze(out[k]); return Object.freeze(out); };
/**
 * Both programs against the pins of this cluster. Never throws; never "ok" without a hash that matched.
 *   fresh   true for the routes that BUILD an approval, setup step 3 or 4, or a launch: the ten-minute answer is not trusted, the programs'
 *           deploy slots are read again (two 45-byte headers) by this call itself, never by joining a read that started before it
 *           arrived, so an upgrade is seen on the very next build. The pages' reads keep the ten-minute answer and join a read
 *           under way.
 *   route   lpkit checkedRoute(env, g): when only the backup node passed the genesis check (`only`), everything is read there, and
 *           neither its answer nor the program bytes are kept for other requests (like checkGenesis, which remembers only the first
 *           node). The deploy slots it read are remembered like every reading's: a later reading older than them is unavailable.
 * Each refresh reads the two headers first; the whole programs (megabytes on mainnet) are read and hashed only for a deploy slot
 * not seen before on this server (an upgrade, or an extension, always writes a new slot; agave refuses two deploys in one slot).
 * The server remembers the highest deploy slot it has read of each program: a reading older than that, from any request, is a node
 * that lags (a backup after a 429, a load-balanced backend) or a read overtaken by a newer one, and is unavailable. So the answer
 * kept for the pages is simply the last one to finish: an older reading never gets that far.
 */
export async function programHashes(env, fetchImpl = fetch, now = Date.now(), { fresh = false, route = null } = {}) {
  const s = lpSetup(env);
  const table = s.on ? pins[s.cluster] : null;
  if (!table) return frozen({ cluster: s.cluster, ok: false, unavailable: true, which: [], readAt: null, dbc: null, dammV2: null });
  if (route && route.only) return refresh(env, s, table, fetchImpl, now, route, null);
  const key = `${s.cluster}|${s.rpc}`;
  const hit = cache.get(key);
  if (!fresh && hit && now >= hit.at && now - hit.at < CACHE_MS) return hit.result;
  if (!fresh && inflight.has(key)) return inflight.get(key); // a page waits for a read under way; a build reads for itself
  const p = refresh(env, s, table, fetchImpl, now, null, key).finally(() => { if (inflight.get(key) === p) inflight.delete(key); });
  inflight.set(key, p);
  return p;
}

/**
 * One reading of both programs. `keep`: the pages' cache key, or null for a read through the backup alone (its answer and bytes not
 * kept; the newest deploy slot is remembered whatever the route, since a higher one can only refuse).
 */
async function refresh(env, s, table, fetchImpl, now, route, keep) {
  const out = { cluster: s.cluster, readAt: iso(now), ok: false, which: [], dbc: unread(table.dbc), dammV2: unread(table.dammV2) };
  const failed = () => frozen({ ...out, readAt: null, unavailable: true });
  const addresses = KEYS.map((k) => table[k].programData);
  const at = (k) => `${s.cluster}|${table[k].programData}`;
  const top = (k) => newest.get(at(k)) ?? -1n; // the highest deploy slot of k this server has read
  const saw = (k, slot) => { if (slot > top(k)) newest.set(at(k), slot); };
  try {
    // 1. the deploy slot of each program (the loader's 45-byte header): one call for both
    const r = await lpRpc(env, "getMultipleAccounts", [addresses, { encoding: "base64", commitment: "confirmed", dataSlice: { offset: 0, length: 45 } }], fetchImpl, route);
    const heads = r && Array.isArray(r.value) && r.value.length === KEYS.length ? r.value : null;
    if (!heads) throw new Error("rpc_bad_answer");
    const known = {}, need = [];
    KEYS.forEach((k, i) => {
      const d = programData(heads[i]);
      if (!d) return; // no deploy slot to go by: unknown, below
      saw(k, d.slot);
      const seen = keep ? bodies.get(`${at(k)}|${d.slot}`) : null;
      if (seen) known[k] = { slot: d.slot, ...seen }; else need.push([k, d.slot]);
    });
    // 2. a slot not seen before: the whole program, hashed (both in one call when both are new)
    if (need.length) {
      const acc = await readAccounts(env, need.map(([k]) => table[k].programData), fetchImpl, { route });
      for (const [k, headSlot] of need) {
        const a = acc.get(table[k].programData) || null;
        const d = programData(a), f = await fingerprint(a);
        // not a program's bytes (or not all of them), or bytes OLDER than the deploy slot just read: a node that lags (a backup after
        // a 429, a load-balanced backend) answered, not the program that runs now. Unknown, below, and nothing of it kept.
        if (!d || !f || d.slot < headSlot) continue;
        known[k] = { slot: d.slot, ...f }; // the slot of the bytes read (a deploy in between: the newer one, with its own bytes)
        saw(k, d.slot);
        if (keep) {
          bodies.set(`${at(k)}|${d.slot}`, f);
          if (bodies.size > BODIES_MAX) bodies.delete(bodies.keys().next().value);
        }
      }
    }
    // 3. each program judged on its reading, unless this server has read a later deploy of it meanwhile (in this request or another):
    // then the reading is not the program that runs now
    let unavailable = false;
    for (const k of KEYS) {
      const x = known[k];
      if (!x || x.slot < top(k)) { unavailable = true; continue; }
      out[k] = { ...out[k], slot: x.slot.toString(), size: x.size, sha256: x.sha256, ok: x.sha256 === table[k].sha256 };
      if (!out[k].ok) out.which.push(k);
    }
    if (unavailable) return failed(); // a program that could not be read clearly: asked again next time, nothing kept for the pages
  } catch (e) {
    console.error("meteora program read failed", codeOf(e));
    return failed();
  }
  out.ok = out.which.length === 0;
  const result = frozen(out);
  if (keep) cache.set(keep, { at: now, result }); // with the check above, in the same step: the pages keep the newest reading
  return result;
}

const short12 = (h) => (h ? `${h.slice(0, 12)}…` : "unknown");
/**
 * null when both programs are the tested builds; else the refusal. A program that CHANGED is a definite block (409) even when the
 * other could not be read; nothing known at all is 503, asked again next time. `what` names what waits ("Approvals", "Launches").
 */
export function programRefusal(h, what = "Approvals") {
  if (h && h.ok && !h.unavailable) return null;
  const which = h && Array.isArray(h.which) ? h.which : [];
  if (which.length) {
    const names = which.map((k) => `its ${PROGRAM_WORDS[k]}`).join(" and "), two = which.length > 1, it = two ? "them" : "it";
    const now = which.map((k) => short12(h[k] && h[k].sha256)).join(" / "), was = which.map((k) => short12(h[k] && h[k].pinned)).join(" / ");
    return { status: 409, error: "program_changed", which: [...which], checkedAt: h.readAt, message: `Meteora has updated ${names} since the team checked ${it} (fingerprint${two ? "s" : ""} now ${now}, checked ${was}). ${what} wait until the team re-tests ${it}.` };
  }
  return { status: 503, error: "program_check_unavailable", which: [], checkedAt: null, message: `Meteora's programs could not be checked against the builds the team tested just now, so nothing was built. ${what} wait until the check works again; try again in a minute.` };
}
/** The pages' view of a programHashes answer. */
export function programSummary(h) {
  const r = programRefusal(h);
  const pick = (p) => (p ? { programId: p.programId, slot: p.slot, size: p.size, sha256: p.sha256, pinned: p.pinned, ok: p.ok } : null);
  return {
    state: !r ? "ok" : r.error === "program_changed" ? "changed" : "unavailable",
    which: r ? r.which : [], checkedAt: h ? h.readAt : null, message: r ? r.message : null,
    dbc: h ? pick(h.dbc) : null, dammV2: h ? pick(h.dammV2) : null,
  };
}
