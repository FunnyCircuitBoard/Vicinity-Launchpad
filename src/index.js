// src/index.js: recovered from the code deployed on Cloudflare (Worker "vicinity-map", 2026-10-02).
// The original comments and formatting were lost in the bundle; the code is the deployed code, byte for byte after bundling.
import { OFFICIAL, activeMint, checkOfficial, officialFor } from "./official.js";
import { SECURITY_HEADERS, json } from "./http.js";
import { base58Encode, buildMessage, isSolanaAddress, statementFor } from "./solana.js";
import { readSigned } from "./signed.js";
import { ensureSchema } from "./store.js";
import { getHolding, getTokenFacts, getTopHolders, holderSnapshot, rankOf } from "./chain.js";
import { POLICY, founderAmount } from "./policy.js";
import { handleEmailStart, handleEmailVerify, handleLogout, handleOAuthCallback, handleOAuthStart, handlePairFinish, handlePairStart, handlePairStatus, handleReprove, handleTransferCheck, handleTransferStart, handleWalletLogin } from "./auth.js";
import { managerOf } from "./roles.js";
import { handleAdmin } from "./admin.js";
import { ledgerStatus } from "./ledger.js";
import { handleLocate } from "./attest.js";
import { handleApply, handleDecideObjection, handleEndorse, handleObject, handleResign, handleResult, handleSeats as handleSeats2, handleSquadApply, handleSquadCreate, handleSquadGet, handleSquadJoin, handleSquadLeave, handleWithdraw } from "./seats.js";
import { handleElectionResult, handleElectionVote } from "./elections.js";
import { handleContactEmailVerify, handleHome, handleMe as handleMe2, handleMembers, handlePhone, handleTermsAgree, handleUsername } from "./me.js";
import { handleMedia, handleNewPost, handlePosts, handleReport, handleVote } from "./social.js";
import { handleAppeal, handleAudit as handleAudit2, handleBanDecision, handleDecideAppeal, handleHide, handleModQueue, handleMyTowns, handleProposeBan, handleTownDecision, handleTownRequest, handleUnhide } from "./moderation.js";
import { handleCancelSnapshot, handleProof, handleSnapshotData, handleSnapshots as handleSnapshots2, snapshotCutoff } from "./snapshot.js";
import { handleCoins, handleDecideMint, handleDesign, handlePrices, handleProposeMint, handleTakedown } from "./coins.js";
import { runJobs } from "./jobs.js";
async function cached(key, seconds, produce) {
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const req = new Request("https://cache.vicinity.internal/" + key);
  if (cache) {
    const hit = await cache.match(req);
    if (hit) return hit;
  }
  const res = await produce();
  if (cache && res.status === 200) {
    const copy = new Response(res.clone().body, res);
    copy.headers.set("Cache-Control", `public, max-age=${seconds}`);
    await cache.put(req, copy);
  }
  return res;
}
async function handleVerify(request, env = {}, now = Date.now(), fetchImpl = fetch) {
  const r = await readSigned(request, now, ["verify"], "verified");
  if (r.error) return r.error;
  const address = r.parsed.address;
  console.log("wallet verified", address.slice(0, 4) + "\u2026" + address.slice(-4));
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
async function tokenPrice(mint, fetchImpl) {
  try {
    const res = await fetchImpl(`https://lite-api.jup.ag/price/v3?ids=${mint}`, { signal: AbortSignal.timeout(3e3) });
    if (!res.ok) return null;
    const p = Number((await res.json())?.[mint]?.usdPrice);
    return Number.isFinite(p) && p > 0 ? p : null;
  } catch {
    return null;
  }
}
async function holdersResponse(env, mint, fetchImpl) {
  try {
    const snap = await holderSnapshot(env, mint, fetchImpl);
    return json({ launched: true, mint, supply: snap.facts.supply, total: snap.people, full: true, holders: snap.rows.slice(0, 1e3), updatedAt: snap.at });
  } catch (e) {
    console.error("full holder list failed, using the top 20", String(e));
  }
  try {
    const { facts, holders } = await getTopHolders(env, mint, fetchImpl);
    return json({ launched: true, mint, supply: facts.supply, total: null, full: false, holders, updatedAt: (/* @__PURE__ */ new Date()).toISOString() });
  } catch (e) {
    console.error("holders failed", String(e));
    return json({ launched: true, error: "chain_unavailable" }, 503);
  }
}
async function rankResponse(env, mint, address, fetchImpl) {
  const founderMin = founderAmount(0);
  try {
    const snap = await holderSnapshot(env, mint, fetchImpl);
    return json({ launched: true, full: true, address, ...rankOf(snap, address), supply: snap.facts.supply, founderMin, updatedAt: snap.at });
  } catch {
  }
  try {
    const amount = await getHolding(env, address, mint, fetchImpl);
    return json({ launched: true, full: false, address, amount, rank: null, total: null, founderMin, updatedAt: (/* @__PURE__ */ new Date()).toISOString() });
  } catch {
    return json({ launched: true, error: "chain_unavailable" }, 503);
  }
}
async function handleApi(request, env = {}, fetchImpl = fetch) {
  const url = new URL(request.url);
  const method = request.method;
  const only = (m2) => method === m2 ? null : json({ error: "method_not_allowed" }, 405);
  const path = url.pathname;
  const needsDb = () => env.DB ? null : json({ ok: false, error: "unavailable" }, 503);
  const db = async (fn) => needsDb() || (await ensureSchema(env.DB), fn());
  if (path.startsWith("/api/admin/")) return db(() => handleAdmin(request, env));
  const oauth = path.match(/^\/api\/auth\/(google)\/(start|callback)$/);
  if (oauth) return only("GET") || (oauth[2] === "start" ? handleOAuthStart(request, env, oauth[1]) : handleOAuthCallback(request, env, oauth[1], fetchImpl));
  if (path === "/api/auth/email/start") return only("POST") || db(() => handleEmailStart(request, env, fetchImpl));
  if (path === "/api/auth/email/verify") return only("POST") || db(() => handleEmailVerify(request, env, fetchImpl));
  let m = path.match(/^\/api\/media\/([0-9]{1,10})$/);
  if (m) return only("GET") || handleMedia(env, m[1]);
  m = path.match(/^\/api\/seats\/results\/([0-9]{1,10})$/);
  if (m) return only("GET") || db(() => handleResult(env, m[1]));
  m = path.match(/^\/api\/seats\/squad\/([0-9]{1,10})$/);
  if (m) return only("GET") || db(() => handleSquadGet(env, m[1], Date.now(), fetchImpl));
  m = path.match(/^\/api\/elections\/results\/([0-9]{1,10})$/);
  if (m) return only("GET") || db(() => handleElectionResult(env, m[1]));
  m = path.match(/^\/api\/snapshots\/([0-9]{1,10})\/(proof|data)$/);
  if (m) return only("GET") || db(() => m[2] === "proof" ? handleProof(env, m[1], url.searchParams.get("wallet")) : handleSnapshotData(env, m[1]));
  switch (path) {
    case "/api/health":
      return only("GET") || json({ ok: true, service: "vicinity-map", milestone: 2 });
    case "/api/official":
      return only("GET") || json(officialFor(env));
    case "/api/policy":
      return only("GET") || json({
        policy: POLICY,
        snapshotCutoff: snapshotCutoff(env),
        launched: Boolean(activeMint(env)),
        balanceHistory: env.DB ? await ledgerStatus(env, Date.now()) : { running: false }
      });
    case "/api/check":
      return only("GET") || json(checkOfficial(url.searchParams.get("q"), isSolanaAddress));
    case "/api/verify":
      return only("POST") || handleVerify(request, env, Date.now(), fetchImpl);
    case "/api/token": {
      const blocked = only("GET");
      if (blocked) return blocked;
      const mint = activeMint(env);
      if (!mint) return json({ launched: false, registry: OFFICIAL.tokens });
      return cached("token-" + mint, 60, async () => {
        try {
          const [facts, price] = await Promise.all([getTokenFacts(env, mint, fetchImpl), tokenPrice(mint, fetchImpl)]);
          return json({ launched: true, registry: OFFICIAL.tokens, facts, price, marketCap: price && facts.supply ? price * facts.supply : null });
        } catch (e) {
          console.error("token facts failed", String(e));
          return json({ launched: true, error: "chain_unavailable" }, 503);
        }
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
      const blocked = only("GET");
      if (blocked) return blocked;
      const q2 = url.searchParams;
      const address = q2.get("address");
      if (!isSolanaAddress(address)) return json({ error: "bad_address" }, 400);
      const action = q2.get("action") || "verify";
      let statement;
      if (action === "verify") statement = statementFor("verify");
      else if (action === "login" && (!q2.get("pin") || /^[0-9]{2}$/.test(q2.get("pin")))) statement = statementFor("login", { pin: q2.get("pin") || void 0 });
      else return json({ error: "bad_request" }, 400);
      const nonce = base58Encode(crypto.getRandomValues(new Uint8Array(16)));
      return json({ message: buildMessage({ host: url.host, address, nonce, issuedAt: (/* @__PURE__ */ new Date()).toISOString(), statement }) });
    }
    // founder seats (and the map)
    case "/api/seats":
    case "/api/claims": {
      const blocked = only("GET");
      if (blocked) return blocked;
      if (!env.DB) return json({ launched: Boolean(activeMint(env)), seats: [], windows: [] });
      await ensureSchema(env.DB);
      const res = await handleSeats2(env);
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
      return only("GET") || handleMe2(request, env, fetchImpl);
    case "/api/me/terms":
      return only("POST") || handleTermsAgree(request, env);
    case "/api/me/username":
      return only("POST") || handleUsername(request, env);
    case "/api/me/phone":
      return only("POST") || handlePhone(request, env);
    case "/api/me/contact/email/verify":
      return only("POST") || handleContactEmailVerify(request, env);
    case "/api/home":
      return only("POST") || handleHome(request, env);
    case "/api/locate":
      return only("POST") || handleLocate(request, env);
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
      return only("GET") || db(() => handleAudit2(env, url));
    case "/api/towns":
      if (method === "POST") return handleTownRequest(request, env);
      return only("GET") || handleMyTowns(request, env);
    case "/api/towns/decide":
      return only("POST") || handleTownDecision(request, env, fetchImpl);
    // Founding Supporters
    case "/api/snapshots":
      return only("GET") || (env.DB ? db(() => handleSnapshots2(env)) : json({ scheduledCutoff: snapshotCutoff(env), snapshots: [] }));
    case "/api/snapshots/cancel":
      return only("POST") || handleCancelSnapshot(request, env);
    default:
      return json({ error: "not_found" }, 404);
  }
}
function withSecurityHeaders(response) {
  const res = new Response(response.body, response);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (k !== "Cache-Control") res.headers.set(k, v);
  return res;
}
var CANONICAL_HOST = "vicinity.city";
var FORWARD_HOSTS = /* @__PURE__ */ new Set(["www.vicinity.city", "vicinitycity.net", "www.vicinitycity.net"]);
var LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|.+\.localhost)$/;
var isLocal = (request, url) => LOCAL_HOST.test(url.hostname) || ["127.0.0.1", "::1"].includes(request.headers.get("cf-connecting-ip"));
export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const insecure = url.protocol === "http:" && !isLocal(request, url);
      if (FORWARD_HOSTS.has(url.hostname) || insecure) {
        if (FORWARD_HOSTS.has(url.hostname)) url.hostname = CANONICAL_HOST;
        url.protocol = "https:";
        url.port = "";
        return new Response(null, { status: 301, headers: { Location: url.toString(), ...SECURITY_HEADERS, "Cache-Control": "public, max-age=3600" } });
      }
      if (url.pathname.startsWith("/api/")) return await handleApi(request, env);
      return withSecurityHeaders(await env.ASSETS.fetch(request));
    } catch (err) {
      console.error("Unhandled error:", err && err.stack ? err.stack : err);
      return json({ error: "internal_error" }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runJobs(env, Date.now()).then((r) => console.log("jobs", JSON.stringify(r))).catch((e) => console.error("jobs failed", String(e))));
  }
};
export { activeMint, handleApi, handleVerify, json, withSecurityHeaders };
