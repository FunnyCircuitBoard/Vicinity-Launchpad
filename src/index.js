/**
 * Vicinity — backend (Cloudflare Worker). Every 10 minutes the scheduled job (src/jobs.js) keeps the
 * balance history, founder seats, elections, moderation and snapshots moving.
 *
 * Public:
 *   GET  /api/health · /api/official · /api/check?q= · /api/policy (the rules, their version, and job health)
 *   GET  /api/token · /api/holders · /api/rank?address=      live token facts, holders, one wallet's rank
 *   GET  /api/message?address&action=verify|login            the exact text a wallet signs
 *   POST /api/verify                                         check a signed message (nothing stored)
 *   GET  /api/seats (also /api/claims) · /api/seats/results/:id   founder seats, open windows, published results
 *   GET  /api/moderator?country= · /api/elections/results/:id     country managers
 *   GET  /api/members · /api/audit?country=                  members per community; every moderation decision
 *   GET  /api/snapshots · /api/snapshots/:id/proof?wallet= · /api/snapshots/:id/data   Founding Supporters
 * Accounts (src/auth.js): /api/auth/wallet · /api/auth/transfer(/check) · /api/auth/reprove · /api/pair(/finish)
 *   · /api/auth/google/start|callback · /api/auth/email/{start,verify} · /api/auth/logout
 * New sign-up, only while SIGNUP_FLOW=v2 (otherwise 404 not_enabled; src/signup.js, src/pwlogin.js):
 *   /api/signup/{start,state,terms,finish} · /api/signup/location(/choice) · /api/signup/location/handoff(/info,/complete,/claim)
 *   · /api/signup/account/reset · /api/signup/email(/verify) · /api/auth/google/start?signup=1
 *   · /api/auth/email/login · /api/auth/password/reset(/start) · /api/me/password
 * Signed in: /api/me · /api/me/{terms,username,phone} · /api/me/contact/email/{verify,remove} · /api/home
 *   · /api/locate (the place a location is read, with /api/locate/handoff/* when a wallet app's browser can't
 *   share GPS: src/handoff.js) · /api/posts(/vote, /report)
 *   · /api/seats/{apply,withdraw,endorse,object,resign} · /api/elections/vote · /api/appeals · /api/towns
 *   · /api/seats/squad/{create,join,leave,apply} · /api/seats/squad/:id (readiness)
 * Admins: /api/admin/* (src/admin.js: fresh wallet proof on every change)
 * Moderators: /api/mod · /api/mod/{hide,unhide,ban,ban/approve,ban/reject} · /api/appeals/decide
 *   · /api/towns/decide · /api/seats/objections/decide · /api/snapshots/cancel
 *
 * Everything else is served from /public by Cloudflare's static asset handler.
 * Settings: SOLANA_RPC_URL, VICINITY_MINT, ADMIN_WALLETS, GOOGLE_CLIENT_ID/SECRET, the e-mail sender settings (see docs/DEPLOY.md),
 * SNAPSHOT_CUTOFF, ATTEST_KEY (optional).
 */
import { activeMint, checkOfficial, officialFor, withMint } from "./official.js";
import { handleAdmin } from "./admin.js";
import { getHolding, getTokenFacts, getTopHolders, holderSnapshot, rankOf } from "./chain.js";
import { base58Encode, buildMessage, isSolanaAddress, statementFor } from "./solana.js";
import { SECURITY_HEADERS, json } from "./http.js";
import { readSigned } from "./signed.js";
import { ensureSchema } from "./store.js";
import { POLICY, founderAmount } from "./policy.js";
import { ledgerStatus } from "./ledger.js";
import { handleEmailStart, handleEmailVerify, handleLogout, handleOAuthCallback, handleOAuthStart, handlePairFinish, handlePairStart, handlePairStatus,
  handleReprove, handleTransferCheck, handleTransferStart, handleWalletLogin } from "./auth.js";
import { handleContactEmailRemove, handleContactEmailVerify, handleHome, handleMe, handleMembers, handlePhone, handleTermsAgree, handleUsername } from "./me.js";
import { handleLocate } from "./attest.js";
import { handleHandoffClaim, handleHandoffComplete, handleHandoffInfo, handleHandoffStart } from "./handoff.js";
import { handleMedia, handleNewPost, handlePosts, handleReport, handleVote } from "./social.js";
import { handleApply, handleDecideObjection, handleEndorse, handleObject, handleResign, handleResult, handleSeats, handleSquadApply, handleSquadCreate, handleSquadGet, handleSquadJoin, handleSquadLeave, handleWithdraw } from "./seats.js";
import { handleElectionResult, handleElectionVote } from "./elections.js";
import { handleAppeal, handleAudit, handleBanDecision, handleDecideAppeal, handleHide, handleModQueue, handleMyTowns, handleProposeBan,
  handleTownDecision, handleTownRequest, handleUnhide } from "./moderation.js";
import { handleCancelSnapshot, handleProof, handleSnapshotData, handleSnapshots, snapshotCutoff } from "./snapshot.js";
import { managerOf } from "./roles.js";
import { handleCoins, handleDecideMint, handleDesign, handlePrices, handleProposeMint, handleTakedown } from "./coins.js";
import { runJobs } from "./jobs.js";
import { v2On } from "./flags.js";
import { routeV2 } from "./signup.js";

export { json, activeMint };

/** Cache small JSON answers for a short time so we don't hammer the blockchain. */
async function cached(key, seconds, produce) {
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const req = new Request("https://cache.vicinity.internal/" + key);
  if (cache) { const hit = await cache.match(req); if (hit) return hit; }
  const res = await produce();
  if (cache && res.status === 200) {
    const copy = new Response(res.clone().body, res);
    copy.headers.set("Cache-Control", `public, max-age=${seconds}`);
    await cache.put(req, copy);
  }
  return res;
}

export async function handleVerify(request, env = {}, now = Date.now(), fetchImpl = fetch) {
  const r = await readSigned(request, now, ["verify"], "verified");
  if (r.error) return r.error;
  const address = r.parsed.address;
  console.log("wallet verified", address.slice(0, 4) + "…" + address.slice(-4));
  const out = { verified: true, address, verifiedAt: new Date(now).toISOString(), launched: false };
  const mint = activeMint(env);
  if (mint) {
    out.launched = true;
    try {
      const amount = await getHolding(env, address, mint, fetchImpl);
      out.holder = amount > 0;
      out.amount = amount;
      out.tier = amount > 0 ? "Holder" : null;
    } catch (e) {
      console.error("holding lookup failed", String(e));
      out.holderCheck = "unavailable";
    }
  }
  return json(out);
}

/** USD price from Jupiter's public price API (asked by the server, so the page loads nothing from other sites). null if unknown. */
async function tokenPrice(mint, fetchImpl) {
  try {
    const res = await fetchImpl(`https://lite-api.jup.ag/price/v3?ids=${mint}`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const p = Number((await res.json())?.[mint]?.usdPrice);
    return Number.isFinite(p) && p > 0 ? p : null;
  } catch { return null; }
}

/** Live holders: every holder from the one-minute snapshot, or the top 20 when the RPC can't list them all. */
async function holdersResponse(env, mint, fetchImpl) {
  try {
    const snap = await holderSnapshot(env, mint, fetchImpl);
    return json({ launched: true, mint, supply: snap.facts.supply, total: snap.people, full: true, holders: snap.rows.slice(0, 1000), updatedAt: snap.at });
  } catch (e) {
    console.error("full holder list failed, using the top 20", String(e));
  }
  try {
    const { facts, holders } = await getTopHolders(env, mint, fetchImpl);
    return json({ launched: true, mint, supply: facts.supply, total: null, full: false, holders, updatedAt: new Date().toISOString() });
  } catch (e) {
    console.error("holders failed", String(e));
    return json({ launched: true, error: "chain_unavailable" }, 503);
  }
}

/** Where does a wallet stand? Read-only; the address is not stored. */
async function rankResponse(env, mint, address, fetchImpl) {
  const founderMin = founderAmount(0);
  try {
    const snap = await holderSnapshot(env, mint, fetchImpl);
    return json({ launched: true, full: true, address, ...rankOf(snap, address), supply: snap.facts.supply, founderMin, updatedAt: snap.at });
  } catch { /* fall back to the balance alone */ }
  try {
    const amount = await getHolding(env, address, mint, fetchImpl);
    return json({ launched: true, full: false, address, amount, rank: null, total: null, founderMin, updatedAt: new Date().toISOString() });
  } catch {
    return json({ launched: true, error: "chain_unavailable" }, 503);
  }
}

// Routes that exist only in the new sign-up (SIGNUP_FLOW=v2), besides everything under /api/signup/.
const V2_EXACT = new Set(["/api/auth/email/login", "/api/auth/password/reset/start", "/api/auth/password/reset", "/api/me/password"]);

export async function handleApi(request, env = {}, fetchImpl = fetch, ctx = null) {
  const url = new URL(request.url);
  const method = request.method;
  const only = (m) => (method === m ? null : json({ error: "method_not_allowed" }, 405));
  const path = url.pathname;
  const needsDb = () => (env.DB ? null : json({ ok: false, error: "unavailable" }, 503));
  const db = async (fn) => needsDb() || (await ensureSchema(env.DB), fn());

  // the new sign-up and password log-in: with the switch off they are simply not there (before any method check, so nothing can be probed)
  if (path.startsWith("/api/signup/") || V2_EXACT.has(path)) {
    if (!v2On(env)) return json({ ok: false, error: "not_enabled" }, 404);
    return routeV2(request, env, fetchImpl, ctx);
  }

  // paths with an id in them
  if (path.startsWith("/api/admin/")) return db(() => handleAdmin(request, env));
  const oauth = path.match(/^\/api\/auth\/(google)\/(start|callback)$/);
  if (oauth) return only("GET") || (oauth[2] === "start" ? handleOAuthStart(request, env, oauth[1]) : handleOAuthCallback(request, env, oauth[1], fetchImpl));
  if (path === "/api/auth/email/start") return only("POST") || db(() => handleEmailStart(request, env, fetchImpl));
  if (path === "/api/auth/email/verify") return only("POST") || db(() => handleEmailVerify(request, env, fetchImpl));
  let m = path.match(/^\/api\/media\/([0-9]{1,10})$/);
  if (m) return only("GET") || handleMedia(request, env, m[1], fetchImpl);
  m = path.match(/^\/api\/seats\/results\/([0-9]{1,10})$/);
  if (m) return only("GET") || db(() => handleResult(env, m[1]));
  m = path.match(/^\/api\/seats\/squad\/([0-9]{1,10})$/);
  if (m) return only("GET") || db(() => handleSquadGet(env, m[1], Date.now(), fetchImpl));
  m = path.match(/^\/api\/elections\/results\/([0-9]{1,10})$/);
  if (m) return only("GET") || db(() => handleElectionResult(env, m[1]));
  m = path.match(/^\/api\/snapshots\/([0-9]{1,10})\/(proof|data)$/);
  if (m) return only("GET") || db(() => (m[2] === "proof" ? handleProof(env, m[1], url.searchParams.get("wallet")) : handleSnapshotData(env, m[1])));

  switch (path) {
    case "/api/health":
      return only("GET") || json({ ok: true, service: "vicinity-map", milestone: 2 });
    case "/api/official":
      return only("GET") || json(officialFor(env));
    case "/api/policy":
      return only("GET") || json({ policy: POLICY, snapshotCutoff: snapshotCutoff(env), launched: Boolean(activeMint(env)),
        balanceHistory: env.DB ? await ledgerStatus(env, Date.now()) : { running: false } });
    case "/api/check":
      return only("GET") || json(checkOfficial(url.searchParams.get("q"), isSolanaAddress, env));
    case "/api/verify":
      return only("POST") || handleVerify(request, env, Date.now(), fetchImpl);
    case "/api/token": {
      const blocked = only("GET");
      if (blocked) return blocked;
      const mint = activeMint(env);
      if (!mint) return json({ launched: false, registry: withMint(env).tokens });
      return cached("token-" + mint, 60, async () => {
        try {
          const [facts, price] = await Promise.all([getTokenFacts(env, mint, fetchImpl), tokenPrice(mint, fetchImpl)]);
          return json({ launched: true, registry: withMint(env).tokens, facts, price, marketCap: price && facts.supply ? price * facts.supply : null });
        } catch (e) { console.error("token facts failed", String(e)); return json({ launched: true, error: "chain_unavailable" }, 503); }
      });
    }
    case "/api/holders": {
      const blocked = only("GET");
      if (blocked) return blocked;
      const mint = activeMint(env);
      if (!mint) return json({ launched: false, holders: [] });
      return cached("holders-v2-" + mint, 60, () => holdersResponse(env, mint, fetchImpl));
    }
    case "/api/rank": {
      const blocked = only("GET");
      if (blocked) return blocked;
      const address = url.searchParams.get("address");
      if (!isSolanaAddress(address)) return json({ error: "bad_address" }, 400);
      const mint = activeMint(env);
      if (!mint) return json({ launched: false, address, founderMin: founderAmount(0) });
      return rankResponse(env, mint, address, fetchImpl);
    }
    case "/api/message": {
      // Helper so the browser builds exactly the same text the server expects.
      const blocked = only("GET");
      if (blocked) return blocked;
      const q = url.searchParams;
      const address = q.get("address");
      if (!isSolanaAddress(address)) return json({ error: "bad_address" }, 400);
      const action = q.get("action") || "verify";
      let statement;
      if (action === "verify") statement = statementFor("verify");
      else if (action === "login" && (!q.get("pin") || /^[0-9]{2}$/.test(q.get("pin")))) statement = statementFor("login", { pin: q.get("pin") || undefined });
      else return json({ error: "bad_request" }, 400);
      const nonce = base58Encode(crypto.getRandomValues(new Uint8Array(16)));
      return json({ message: buildMessage({ host: url.host, address, nonce, issuedAt: new Date().toISOString(), statement }) });
    }

    // founder seats (and the map)
    case "/api/seats":
    case "/api/claims": {
      const blocked = only("GET");
      if (blocked) return blocked;
      if (!env.DB) return json({ launched: Boolean(activeMint(env)), seats: [], windows: [] });
      await ensureSchema(env.DB);
      const res = await handleSeats(env);
      const body = await res.json();
      return json({ ...body, launched: Boolean(activeMint(env)), founderAmount: founderAmount(0) });
    }
    case "/api/seats/apply":
      return only("POST") || handleApply(request, env, fetchImpl);
    case "/api/seats/withdraw":
      return only("POST") || handleWithdraw(request, env);
    case "/api/seats/endorse":
      return only("POST") || handleEndorse(request, env);
    case "/api/seats/object":
      return only("POST") || handleObject(request, env);
    case "/api/seats/resign":
      return only("POST") || handleResign(request, env);
    case "/api/seats/objections/decide":
      return only("POST") || handleDecideObjection(request, env, fetchImpl);
    case "/api/seats/squad/create":
      return only("POST") || handleSquadCreate(request, env);
    case "/api/seats/squad/join":
      return only("POST") || handleSquadJoin(request, env);
    case "/api/seats/squad/leave":
      return only("POST") || handleSquadLeave(request, env);
    case "/api/seats/squad/apply":
      return only("POST") || handleSquadApply(request, env, fetchImpl);

    // city coins (designed by City Founders) and prices for the swap panel
    case "/api/coins":
      return only("GET") || handleCoins(request, env, fetchImpl);
    case "/api/coins/design":
      return only("POST") || handleDesign(request, env, fetchImpl);
    case "/api/coins/mint":
      return only("POST") || handleProposeMint(request, env, fetchImpl);
    case "/api/coins/mint/decide":
      return only("POST") || handleDecideMint(request, env, fetchImpl);
    case "/api/coins/takedown":
      return only("POST") || handleTakedown(request, env, fetchImpl);
    case "/api/prices":
      return only("GET") || handlePrices(request, env, fetchImpl);

    // country managers
    case "/api/moderator": {
      const blocked = only("GET");
      if (blocked) return blocked;
      const cc = url.searchParams.get("country") || "";
      if (!/^[A-Z]{2}$/.test(cc)) return json({ error: "bad_country" }, 400);
      const rule = "Elected for 90 days by the country's verified locals (votes 50%, service 30%, capped holdings 20%). Until then, the admin covers it.";
      if (!env.DB) return json({ country: cc, manager: null, rule });
      await ensureSchema(env.DB);
      const mgr = await managerOf(env, cc);
      return json({ country: cc, rule, manager: mgr ? { name: mgr.name, city: mgr.city, endsAt: mgr.term.ends_at, since: mgr.term.starts_at } : null });
    }
    case "/api/elections/vote":
      return only("POST") || handleElectionVote(request, env);

    // accounts
    case "/api/auth/wallet":
      return only("POST") || handleWalletLogin(request, env);
    case "/api/auth/reprove":
      return only("POST") || handleReprove(request, env);
    case "/api/auth/transfer":
      return only("POST") || handleTransferStart(request, env);
    case "/api/auth/transfer/check":
      return only("POST") || handleTransferCheck(request, env, Date.now(), fetchImpl);
    case "/api/auth/logout":
      return only("POST") || handleLogout(request, env);
    case "/api/pair":
      if (method === "POST") return handlePairStart(request, env);
      return only("GET") || handlePairStatus(request, env);
    case "/api/pair/finish":
      return only("POST") || handlePairFinish(request, env);

    // dashboard
    case "/api/me":
      return only("GET") || handleMe(request, env, fetchImpl);
    case "/api/me/terms":
      return only("POST") || handleTermsAgree(request, env);
    case "/api/me/username":
      return only("POST") || handleUsername(request, env);
    case "/api/me/phone":
      return only("POST") || handlePhone(request, env);
    case "/api/me/contact/email/verify":
      return only("POST") || handleContactEmailVerify(request, env);
    case "/api/me/contact/email/remove":
      return only("POST") || handleContactEmailRemove(request, env);
    case "/api/home":
      return only("POST") || handleHome(request, env);
    case "/api/locate":
      return only("POST") || handleLocate(request, env);
    case "/api/locate/handoff":
      return only("POST") || db(() => handleHandoffStart(request, env));
    case "/api/locate/handoff/info":
      return only("POST") || db(() => handleHandoffInfo(request, env));
    case "/api/locate/handoff/complete":
      return only("POST") || db(() => handleHandoffComplete(request, env));
    case "/api/locate/handoff/claim":
      return only("POST") || db(() => handleHandoffClaim(request, env));
    case "/api/members":
      return only("GET") || cached("members", 60, () => handleMembers(env));

    // feeds
    case "/api/posts":
      if (method === "POST") return handleNewPost(request, env, fetchImpl);
      return only("GET") || handlePosts(request, env, fetchImpl);
    case "/api/posts/vote":
      return only("POST") || handleVote(request, env, fetchImpl);
    case "/api/posts/report":
      return only("POST") || handleReport(request, env, fetchImpl);

    // moderation
    case "/api/mod":
      return only("GET") || handleModQueue(request, env, fetchImpl);
    case "/api/mod/hide":
      return only("POST") || handleHide(request, env, fetchImpl);
    case "/api/mod/unhide":
      return only("POST") || handleUnhide(request, env, fetchImpl);
    case "/api/mod/ban":
      return only("POST") || handleProposeBan(request, env, fetchImpl);
    case "/api/mod/ban/approve":
      return only("POST") || handleBanDecision(request, env, true, fetchImpl);
    case "/api/mod/ban/reject":
      return only("POST") || handleBanDecision(request, env, false, fetchImpl);
    case "/api/appeals":
      return only("POST") || handleAppeal(request, env);
    case "/api/appeals/decide":
      return only("POST") || handleDecideAppeal(request, env, fetchImpl);
    case "/api/audit":
      return only("GET") || db(() => handleAudit(env, url));
    case "/api/towns":
      if (method === "POST") return handleTownRequest(request, env);
      return only("GET") || handleMyTowns(request, env);
    case "/api/towns/decide":
      return only("POST") || handleTownDecision(request, env, fetchImpl);

    // Founding Supporters
    case "/api/snapshots":
      return only("GET") || (env.DB ? db(() => handleSnapshots(env)) : json({ scheduledCutoff: snapshotCutoff(env), snapshots: [] }));
    case "/api/snapshots/cancel":
      return only("POST") || handleCancelSnapshot(request, env);
    default:
      return json({ error: "not_found" }, 404);
  }
}

export function withSecurityHeaders(response) {
  const res = new Response(response.body, response);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (k !== "Cache-Control") res.headers.set(k, v);
  return res;
}

/** vicinity.city is the address; the old one and the www versions forward there, keeping the path.
 *  Plain http:// visits are sent to https:// (except on this computer, for `wrangler dev`). */
const CANONICAL_HOST = "vicinity.city";
const FORWARD_HOSTS = new Set(["www.vicinity.city", "vicinitycity.net", "www.vicinitycity.net"]);
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|.+\.localhost)$/;
// `wrangler dev` presents local visits as http://vicinity.city, but from this computer's own address.
const isLocal = (request, url) =>
  LOCAL_HOST.test(url.hostname) || ["127.0.0.1", "::1"].includes(request.headers.get("cf-connecting-ip"));

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const insecure = url.protocol === "http:" && !isLocal(request, url);
      if (FORWARD_HOSTS.has(url.hostname) || insecure) {
        if (FORWARD_HOSTS.has(url.hostname)) url.hostname = CANONICAL_HOST;
        url.protocol = "https:"; url.port = "";
        return new Response(null, { status: 301, headers: { Location: url.toString(), ...SECURITY_HEADERS, "Cache-Control": "public, max-age=3600" } });
      }
      if (url.pathname.startsWith("/api/")) return await handleApi(request, env, fetch, ctx);
      return withSecurityHeaders(await env.ASSETS.fetch(request));
    } catch (err) {
      console.error("Unhandled error:", err && err.stack ? err.stack : err);
      return json({ error: "internal_error" }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runJobs(env, Date.now()).then((r) => console.log("jobs", JSON.stringify(r))).catch((e) => console.error("jobs failed", String(e))));
  },
};
